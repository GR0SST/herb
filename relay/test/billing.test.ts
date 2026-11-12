import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAppleJws } from "../src/apple";
import { createApp } from "../src/app";
import { Store } from "../src/db";
import type { VoiceEngine } from "../src/live";

const DAY = 24 * 60 * 60 * 1000;
const PRODUCT = "cc.grosst.herb.live.monthly";
const BUNDLE = "cc.grosst.herb";

// A certificate chain shaped like Apple's: root, intermediate, leaf. Real Apple data needs Apple's root.
let chain: { root: string; intermediate: string; leaf: string; key: string };

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "herb-pki-"));
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  const ext = (name: string, body: string) => writeFileSync(join(dir, name), body);
  ext("ca.ext", "basicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n");
  ext("leaf.ext", "basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\n");
  for (const name of ["root", "intermediate", "leaf"]) run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);
  run("req", "-new", "-x509", "-key", "root.key", "-subj", "/CN=Test Root", "-days", "3650", "-out", "root.pem", "-addext", "basicConstraints=critical,CA:true", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  run("req", "-new", "-key", "intermediate.key", "-subj", "/CN=Test Intermediate", "-out", "intermediate.csr");
  run("x509", "-req", "-in", "intermediate.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-days", "3650", "-extfile", "ca.ext", "-out", "intermediate.pem");
  run("req", "-new", "-key", "leaf.key", "-subj", "/CN=Test Leaf", "-out", "leaf.csr");
  run("x509", "-req", "-in", "leaf.csr", "-CA", "intermediate.pem", "-CAkey", "intermediate.key", "-CAcreateserial", "-days", "3650", "-extfile", "leaf.ext", "-out", "leaf.pem");
  const der = (name: string) => execFileSync("openssl", ["x509", "-in", `${name}.pem`, "-outform", "der"], { cwd: dir }).toString("base64");
  chain = { root: der("root"), intermediate: der("intermediate"), leaf: der("leaf"), key: readFileSync(join(dir, "leaf.key"), "utf8") };
});

function jws(payload: unknown, x5c = [chain.leaf, chain.intermediate, chain.root]) {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", x5c })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${body}`), { key: createPrivateKey(chain.key), dsaEncoding: "ieee-p1363" });
  return `${header}.${body}.${signature.toString("base64url")}`;
}

function transaction(fields: Partial<Record<string, unknown>> = {}) {
  return {
    transactionId: "t1",
    originalTransactionId: "o1",
    bundleId: BUNDLE,
    productId: PRODUCT,
    purchaseDate: clock - 1000,
    expiresDate: clock + 30 * DAY,
    environment: "Production",
    ...fields,
  };
}

const voice: VoiceEngine = {
  async open() {
    return { client: {}, session: { say() {}, addContext() {}, answer() {}, askExpired() {}, hangup() {} } };
  },
};

let store: Store;
let clock: number;
let app: ReturnType<typeof createApp>;
let phone: string;
let accountId: string;

function makeApp(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  app = createApp({
    store,
    dataDir: mkdtempSync(join(tmpdir(), "herb-billing-")),
    push: null,
    now: () => clock,
    voice,
    billing: true,
    products: { [PRODUCT]: 100 },
    bundleId: BUNDLE,
    sandboxMinutes: 5,
    appleRoots: [chain.root],
    ...extra,
  });
}

function req(path: string, token: string | null, body?: unknown) {
  return app.handle(new Request(`http://relay${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

type Live = {
  unlimited: boolean;
  seconds_left: number | null;
  bonus_seconds: number;
  subscription: { active: boolean; seconds_total: number; seconds_used: number; expires_at: number; sandbox: boolean } | null;
};
const live = async (token = phone) => ((await (await req("/v1/status", token)).json()) as { live: Live }).live;
const buy = (payload: unknown, token = phone) => req("/v1/billing/transactions", token, { jws: jws(payload) });
const notify = (tx: unknown, type = "DID_RENEW", renewal?: unknown) =>
  req("/v1/billing/apple", null, {
    signedPayload: jws({
      notificationType: type,
      data: { bundleId: BUNDLE, signedTransactionInfo: jws(tx), ...(renewal ? { signedRenewalInfo: jws(renewal) } : {}) },
    }),
  });

beforeEach(() => {
  store = new Store(":memory:");
  clock = Date.now();
  const account = store.createAccount(clock);
  accountId = account.id;
  phone = store.addDevice(accountId, "iPhone", clock).token;
  makeApp();
});

describe("signatures", () => {
  test("accepts the chain it trusts and refuses others", () => {
    expect(verifyAppleJws<{ a: number }>(jws({ a: 1 }), { roots: [chain.root], checkMarkers: false }).a).toBe(1);
    expect(() => verifyAppleJws(jws({ a: 1 }))).toThrow("Unknown root");
    const [h, , s] = jws({ a: 1 }).split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ a: 2 })).toString("base64url")}.${s}`;
    expect(() => verifyAppleJws(forged, { roots: [chain.root], checkMarkers: false })).toThrow("Bad signature");
    expect(() => verifyAppleJws(jws({ a: 1 }, [chain.leaf, chain.root, chain.root]), { roots: [chain.root], checkMarkers: false })).toThrow();
    // Real App Store data also needs Apple's marker extensions, which test certificates lack.
    expect(() => verifyAppleJws(jws({ a: 1 }), { roots: [chain.root] })).toThrow("Not an App Store certificate");
  });

  test("a forged purchase is refused", async () => {
    const [h, , s] = jws(transaction()).split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify(transaction({ productId: PRODUCT }))).toString("base64url")}x.${s}`;
    expect((await req("/v1/billing/transactions", phone, { jws: forged })).status).toBe(400);
  });
});

describe("subscription", () => {
  test("a purchase gives the period's minutes, spent by calls", async () => {
    expect((await live()).seconds_left).toBe(0);
    expect((await buy(transaction())).status).toBe(200);
    expect(await live()).toMatchObject({ unlimited: false, seconds_left: 6000, subscription: { active: true, seconds_total: 6000, seconds_used: 0 } });
    // A call of 90 seconds.
    const bot = store.addBot({ accountId, name: "Codex" });
    const started = (await (await req("/v1/live", phone, { bot_id: bot.id })).json()) as { call: { id: string } };
    clock += 90_000;
    await req(`/v1/calls/${started.call.id}/end`, phone, {});
    expect(await live()).toMatchObject({ seconds_left: 5910, subscription: { seconds_used: 90 } });
  });

  test("renewal starts a new period; the same transaction again changes nothing", async () => {
    await buy(transaction());
    store.spendSubscription("o1", 600);
    await buy(transaction());
    expect((await live()).subscription?.seconds_used).toBe(600);
    clock += 30 * DAY;
    expect((await notify(transaction({ transactionId: "t2", purchaseDate: clock, expiresDate: clock + 30 * DAY }))).status).toBe(200);
    expect(await live()).toMatchObject({ seconds_left: 6000, subscription: { active: true, seconds_used: 0 } });
  });

  test("expiry and refunds stop the minutes", async () => {
    await buy(transaction());
    clock += 31 * DAY;
    expect(await live()).toMatchObject({ seconds_left: 0, subscription: { active: false } });
    clock -= 31 * DAY;
    await notify(transaction({ revocationDate: clock }), "REFUND");
    expect((await live()).seconds_left).toBe(0);
  });

  test("auto-renew state comes from Apple's renewal info", async () => {
    await buy(transaction());
    await notify(transaction(), "DID_CHANGE_RENEWAL_STATUS", { originalTransactionId: "o1", autoRenewStatus: 0 });
    expect(store.subscription("o1")!.auto_renew).toBe(0);
  });

  test("signing in with another key moves the subscription, at most once a day", async () => {
    await buy(transaction());
    store.spendSubscription("o1", 600);
    const other = store.createAccount(clock);
    const otherPhone = store.addDevice(other.id, "iPhone", clock).token;
    expect((await buy(transaction(), otherPhone)).status).toBe(200);
    expect(await live(otherPhone)).toMatchObject({ seconds_left: 5400 });
    expect((await live()).seconds_left).toBe(0);
    expect((await buy(transaction())).status).toBe(409);
    clock += DAY + 1;
    expect((await buy(transaction())).status).toBe(200);
  });

  test("sandbox purchases give few minutes; other apps and products are refused", async () => {
    await buy(transaction({ environment: "Sandbox" }));
    expect(await live()).toMatchObject({ seconds_left: 300, subscription: { sandbox: true } });
    expect((await buy(transaction({ originalTransactionId: "o2", bundleId: "com.other" }))).status).toBe(400);
    expect((await buy(transaction({ originalTransactionId: "o3", productId: "nope" }))).status).toBe(400);
  });
});

describe("plans", () => {
  test("unlimited accounts are never counted", async () => {
    store.setUnlimited(accountId, true);
    expect(await live()).toMatchObject({ unlimited: true, seconds_left: null });
  });

  test("bonus minutes are spent after the subscription's", async () => {
    store.addLiveSeconds(accountId, 120);
    await buy(transaction());
    expect((await live()).seconds_left).toBe(6120);
  });

  test("new accounts get the free minutes", async () => {
    makeApp({ freeMinutes: 10 });
    const created = (await (await req("/v1/accounts", null, {})).json()) as { token: string };
    expect(await live(created.token)).toMatchObject({ seconds_left: 600, bonus_seconds: 600 });
  });

  test("without billing everyone is unlimited and purchases are not taken", async () => {
    makeApp({ billing: false });
    expect(await live()).toMatchObject({ billing: false, unlimited: true, seconds_left: null });
    expect((await buy(transaction())).status).toBe(409);
  });
});

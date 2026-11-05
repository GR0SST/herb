import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushResult, PushSender } from "../src/apns";
import { CALLS_PER_DAY, createApp, MAX_TEXT, NEW_ACCOUNTS_PER_IP_HOUR } from "../src/app";
import { type Call, type Device, normalizeKey, RING_TIMEOUT_MS, Store } from "../src/db";

const ORIGIN = "https://relay.test";
const VOIP = "ab".repeat(32);
let store: Store;
let dir: string;
let clock: number;
let sent: { device: Device; call: Call }[];
let pushResult: PushResult;
let app: ReturnType<typeof createApp>;
let upstream: { url: string; init: RequestInit } | null;
let accountId: string;
let accountKey: string;
let devToken: string;
let botToken: string;
let botId: string;
let chatBotId: string;
let chatBotToken: string;
let otherDev: string;
let otherBot: string;

const pushStub: PushSender = {
  async send(device, call) {
    sent.push({ device, call });
    return pushResult;
  },
};

function req(path: string, token: string | null, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return app.handle(new Request(`http://relay${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
}

const place = async (token = botToken, body: unknown = { text: "x" }) =>
  ((await (await req("/v1/call", token, { body })).json()) as { id: string }).id;
const audioCall = { audio_base64: Buffer.from("fake-mp3").toString("base64"), audio_mime: "audio/mpeg" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herb-"));
  store = new Store(join(dir, "t.sqlite"));
  clock = 1_000_000;
  sent = [];
  upstream = null;
  pushResult = { ok: true, status: 200, invalidToken: false };
  app = createApp({
    store,
    dataDir: dir,
    push: pushStub,
    now: () => clock,
    publicUrl: ORIGIN,
    env: { HERMES_KEY: "secret-key" },
    fetchImpl: (async (url: string, init: RequestInit) => {
      upstream = { url, init };
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n", { status: 200 });
    }) as unknown as typeof fetch,
  });
  const account = store.createAccount(clock);
  accountId = account.id;
  accountKey = account.key;
  const device = store.addDevice(accountId, "iPhone", clock);
  devToken = device.token;
  store.setVoipToken(device.id, VOIP, "sandbox");
  const bot = store.addBot({ accountId, name: "Bot" });
  botToken = bot.token;
  botId = bot.id;
  const chatBot = store.addBot({ accountId, name: "Chatty" });
  chatBotId = chatBot.id;
  chatBotToken = chatBot.token;
  store.setBotChat(chatBotId, { url: "http://hermes/v1/", keyEnv: "HERMES_KEY", model: "hermes-agent" });
  const other = store.createAccount(clock);
  const otherDevice = store.addDevice(other.id, "Other phone", clock);
  otherDev = otherDevice.token;
  store.setVoipToken(otherDevice.id, "cd".repeat(32), "production");
  otherBot = store.addBot({ accountId: other.id, name: "Other agent" }).token;
});

describe("auth", () => {
  test("rejects missing and wrong tokens", async () => {
    expect((await req("/v1/bots", null)).status).toBe(401);
    expect((await req("/v1/bots", "nope")).status).toBe(401);
    expect((await req("/mcp", devToken, { body: {} })).status).toBe(401);
  });
  test("agent token cannot read account routes", async () => {
    expect((await req("/v1/bots", botToken)).status).toBe(403);
  });
  test("phone token cannot place calls", async () => {
    expect((await req("/v1/call", devToken, { body: { text: "x" } })).status).toBe(404);
    expect(sent).toHaveLength(0);
  });
  test("agent cannot read another agent's call", async () => {
    const id = await place();
    expect((await req(`/v1/calls/${id}`, chatBotToken)).status).toBe(404);
    expect((await req(`/v1/calls/${id}`, botToken)).status).toBe(200);
  });
});

describe("website", () => {
  test("the home page is public and locked down", async () => {
    const res = await req("/", null);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await res.text()).toContain("Create free account");
    expect((await req("/app.js", null)).status).toBe(200);
    expect((await req("/style.css", null)).status).toBe(200);
  });
  test("legal pages, font and a branded 404 are served", async () => {
    for (const path of ["/config", "/privacy", "/terms", "/fonts/geist.woff2", "/og.png", "/icon.svg"]) expect((await req(path, null)).status).toBe(200);
    const page = await req("/nope", null, { headers: { accept: "text/html" } });
    expect(page.status).toBe(404);
    expect(page.headers.get("content-type")).toContain("text/html");
    const json = await req("/nope", null);
    expect(json.status).toBe(404);
    expect(json.headers.get("content-type")).toContain("application/json");
  });
  test("the website script is valid JavaScript", async () => {
    const source = await Bun.file(join(import.meta.dir, "../public/app.js")).text();
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(source)).not.toThrow();
  });
  test("the configuration page stays out of search results", async () => {
    expect((await req("/config", null)).headers.get("x-robots-tag")).toBe("noindex");
    expect((await req("/", null)).headers.get("x-robots-tag")).toBeNull();
  });
  const web = (path: string, init: { method?: string; body?: unknown; cookie?: string; origin?: string | null } = {}) =>
    req(path, null, {
      method: init.method ?? "POST",
      body: init.body,
      headers: { ...(init.origin === null ? {} : { origin: init.origin ?? ORIGIN }), ...(init.cookie ? { cookie: init.cookie } : {}) },
    });
  const session = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;

  test("signup returns a key once and starts a secure session", async () => {
    const res = await web("/web/signup");
    expect(res.status).toBe(201);
    const { key } = (await res.json()) as { key: string };
    expect(key).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    const bots = await web("/v1/bots", { method: "GET", cookie: session(res), origin: null });
    expect(await bots.json()).toEqual({ bots: [] });
  });
  test("login works with the key typed loosely and refuses a wrong one", async () => {
    const loose = accountKey.toLowerCase().replaceAll("-", " ");
    const res = await web("/web/login", { body: { key: ` ${loose} ` } });
    expect(res.status).toBe(200);
    const { bots } = (await (await web("/v1/bots", { method: "GET", cookie: session(res), origin: null })).json()) as { bots: { name: string }[] };
    expect(bots.map((b) => b.name)).toEqual(["Bot", "Chatty"]);
    expect((await web("/web/login", { body: { key: "WRONG" } })).status).toBe(401);
  });
  test("wrong keys are limited per address", async () => {
    const headers = { origin: ORIGIN, "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < 10; i++) await req("/web/login", null, { body: { key: "WRONG" }, headers });
    expect((await req("/web/login", null, { body: { key: accountKey }, headers })).status).toBe(429);
    expect((await req("/web/login", null, { body: { key: accountKey }, headers: { origin: ORIGIN, "cf-connecting-ip": "203.0.113.10" } })).status).toBe(200);
  });
  test("cross-site requests are refused", async () => {
    expect((await web("/web/signup", { origin: "https://evil.test" })).status).toBe(403);
    expect((await web("/web/login", { origin: null, body: { key: accountKey } })).status).toBe(403);
    const login = await web("/web/login", { body: { key: accountKey } });
    const cookie = session(login);
    expect((await web(`/v1/bots/${botId}`, { method: "DELETE", cookie, origin: "https://evil.test" })).status).toBe(403);
    expect((await web("/v1/account", { method: "DELETE", cookie, origin: null })).status).toBe(403);
    expect(store.bot(botId)).not.toBeNull();
    expect((await web(`/v1/bots/${botId}`, { method: "DELETE", cookie })).status).toBe(204);
  });
  test("logout ends the session", async () => {
    const cookie = session(await web("/web/login", { body: { key: accountKey } }));
    await web("/web/logout", { cookie });
    expect((await web("/v1/bots", { method: "GET", cookie, origin: null })).status).toBe(401);
  });
  test("sessions expire", async () => {
    const cookie = session(await web("/web/login", { body: { key: accountKey } }));
    clock += 31 * 24 * 60 * 60 * 1000;
    expect((await web("/v1/bots", { method: "GET", cookie, origin: null })).status).toBe(401);
  });
  test("a browser session cannot act as a phone", async () => {
    const cookie = session(await web("/web/login", { body: { key: accountKey } }));
    const id = await place();
    expect((await web(`/v1/calls/${id}/status`, { cookie, body: { status: "declined" } })).status).toBe(403);
    expect((await web("/v1/device", { method: "PUT", cookie, body: { voip_token: null } })).status).toBe(403);
  });
  test("deleting from the website clears the session and data", async () => {
    const cookie = session(await web("/web/login", { body: { key: accountKey } }));
    const res = await web("/v1/account", { method: "DELETE", cookie });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(store.accountIdByKey(accountKey)).toBeNull();
    expect((await web("/v1/bots", { method: "GET", cookie, origin: null })).status).toBe(401);
  });
});

describe("accounts", () => {
  const phoneSignup = () => req("/v1/accounts", null, { body: { device_name: "My iPhone" } });

  test("the app creates an account and gets a key and phone token", async () => {
    const res = await phoneSignup();
    expect(res.status).toBe(201);
    const { token, key } = (await res.json()) as { token: string; key: string };
    expect(normalizeKey(key)).toHaveLength(20);
    expect((await req("/v1/bots", token)).status).toBe(200);
  });
  test("a key is stored only as a hash", () => {
    const row = store.db.query<{ key_hash: string }, [string]>("SELECT key_hash FROM accounts WHERE id = ?").get(accountId)!;
    expect(row.key_hash).not.toContain(normalizeKey(accountKey));
  });
  test("signing in with a key adds a phone to the same account", async () => {
    const res = await req("/v1/sessions", null, { body: { key: accountKey, device_name: "iPad" } });
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    const { bots } = (await (await req("/v1/bots", token)).json()) as { bots: unknown[] };
    expect(bots).toHaveLength(2);
    expect((await req("/v1/sessions", null, { body: { key: "WRONG" } })).status).toBe(401);
  });
  test("a call rings every phone on the account and no other", async () => {
    const second = (await (await req("/v1/sessions", null, { body: { key: accountKey } })).json()) as { token: string };
    await req("/v1/device", second.token, { method: "PUT", body: { voip_token: "ef".repeat(32), environment: "sandbox" } });
    await place(botToken);
    expect(sent.map((s) => s.device.voip_token).sort()).toEqual([VOIP, "ef".repeat(32)].sort());
  });
  test("signing out removes only this phone", async () => {
    expect((await req("/v1/device", devToken, { method: "DELETE" })).status).toBe(204);
    expect((await req("/v1/bots", devToken)).status).toBe(401);
    expect(store.accountIdByKey(accountKey)).toBe(accountId);
    expect(store.bot(botId)).not.toBeNull();
  });
  test("a phone can be removed from its account only", async () => {
    const { devices } = (await (await req("/v1/devices", devToken)).json()) as { devices: { id: string; current: boolean }[] };
    expect(devices[0]?.current).toBe(true);
    expect((await req(`/v1/devices/${devices[0]!.id}`, otherDev, { method: "DELETE" })).status).toBe(404);
    expect((await req("/v1/bots", devToken)).status).toBe(200);
  });
  test("sees only own agents and calls", async () => {
    await place();
    const { bots } = (await (await req("/v1/bots", otherDev)).json()) as { bots: { name: string }[] };
    expect(bots.map((b) => b.name)).toEqual(["Other agent"]);
    const { calls } = (await (await req("/v1/calls", otherDev)).json()) as { calls: unknown[] };
    expect(calls).toHaveLength(0);
    const pending = (await (await req("/v1/calls/pending", otherDev)).json()) as { calls: unknown[] };
    expect(pending.calls).toHaveLength(0);
  });
  test("cannot reach a foreign call by id", async () => {
    const id = await place(botToken, audioCall);
    expect((await req(`/v1/calls/${id}`, otherDev)).status).toBe(404);
    expect((await req(`/v1/calls/${id}/audio`, otherDev)).status).toBe(404);
    expect((await req(`/v1/calls/${id}/status`, otherDev, { body: { status: "declined" } })).status).toBe(404);
    expect(store.call(id)?.status).toBe("ringing");
  });
  test("cannot filter into foreign calls with bot_id", async () => {
    await place();
    const { calls } = (await (await req(`/v1/calls?bot_id=${botId}`, otherDev)).json()) as { calls: unknown[] };
    expect(calls).toHaveLength(0);
  });
  test("cannot delete or chat with a foreign agent", async () => {
    expect((await req(`/v1/bots/${botId}`, otherDev, { method: "DELETE" })).status).toBe(404);
    expect(store.bot(botId)).not.toBeNull();
    const res = await req(`/v1/bots/${chatBotId}/chat`, otherDev, { body: { messages: [{ role: "user", content: "x" }] } });
    expect(res.status).toBe(404);
    expect(upstream).toBeNull();
  });
  test("two accounts can use the same agent name", async () => {
    expect((await req("/v1/bots", otherDev, { body: { name: "Bot" } })).status).toBe(201);
  });
  test("new accounts are limited per address", async () => {
    const headers = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < NEW_ACCOUNTS_PER_IP_HOUR; i++) expect((await req("/v1/accounts", null, { body: {}, headers })).status).toBe(201);
    expect((await req("/v1/accounts", null, { body: {}, headers })).status).toBe(429);
    expect((await req("/v1/accounts", null, { body: {}, headers: { "cf-connecting-ip": "203.0.113.10" } })).status).toBe(201);
    clock += 61 * 60 * 1000;
    expect((await req("/v1/accounts", null, { body: {}, headers })).status).toBe(201);
  });
  test("closed registration refuses new accounts but allows sign-in", async () => {
    app = createApp({ store, dataDir: dir, push: null, openRegistration: false, publicUrl: ORIGIN });
    expect((await req("/v1/accounts", null, { body: {} })).status).toBe(403);
    expect((await req("/v1/sessions", null, { body: { key: accountKey } })).status).toBe(201);
  });
  test("deleting an account removes its data and audio", async () => {
    const id = await place(botToken, audioCall);
    const path = join(dir, "audio", id);
    expect(existsSync(path)).toBe(true);
    expect((await req("/v1/account", devToken, { method: "DELETE" })).status).toBe(204);
    expect(store.call(id)).toBeNull();
    expect(store.bot(botId)).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect((await req("/v1/bots", devToken)).status).toBe(401);
    expect((await req("/v1/sessions", null, { body: { key: accountKey } })).status).toBe(401);
    expect((await req("/v1/bots", otherDev)).status).toBe(200);
  });
});

describe("agents", () => {
  test("create returns a working token once", async () => {
    const res = await req("/v1/bots", devToken, { body: { name: "Codex" } });
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    expect((await req("/v1/call", token, { body: { text: "x" } })).status).toBe(202);
    expect(JSON.stringify(await (await req("/v1/bots", devToken)).json())).not.toContain("herb_bot_");
  });
  test("rejects bad and duplicate names", async () => {
    expect((await req("/v1/bots", devToken, { body: { name: " " } })).status).toBe(400);
    expect((await req("/v1/bots", devToken, { body: { name: "x".repeat(41) } })).status).toBe(400);
    expect((await req("/v1/bots", devToken, { body: { name: "Bot" } })).status).toBe(409);
  });
  test("delete cuts off the agent token", async () => {
    expect((await req(`/v1/bots/${botId}`, devToken, { method: "DELETE" })).status).toBe(204);
    expect((await req("/v1/call", botToken, { body: { text: "x" } })).status).toBe(401);
  });
});

describe("test call", () => {
  test("rings the owner's phone from a hidden agent", async () => {
    const res = await req("/v1/test-call", devToken, { body: { text: "Hello" } });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ bot_name: "Test call", title: "Test call", text: "Hello", push: "sent" });
    expect(sent.map((s) => s.device.voip_token)).toEqual([VOIP]);
    const { bots } = (await (await req("/v1/bots", devToken)).json()) as { bots: { name: string }[] };
    expect(bots.map((b) => b.name)).toEqual(["Bot", "Chatty"]);
    const { calls } = (await (await req("/v1/calls", devToken)).json()) as { calls: { bot_name: string }[] };
    expect(calls[0]?.bot_name).toBe("Test call");
  });
  test("text is optional and audio cannot be sent", async () => {
    const res = await req("/v1/test-call", devToken, { body: { text: "", ...audioCall } });
    expect(await res.json()).toMatchObject({ text: null, has_audio: false });
  });
  test("works from the website only with the right origin", async () => {
    const cookie = (await req("/web/login", null, { body: { key: accountKey }, headers: { origin: ORIGIN } })).headers.get("set-cookie")!.split(";")[0]!;
    expect((await req("/v1/test-call", null, { body: {}, headers: { cookie, origin: ORIGIN } })).status).toBe(202);
    expect((await req("/v1/test-call", null, { body: {}, headers: { cookie, origin: "https://evil.test" } })).status).toBe(403);
    expect((await req("/v1/test-call", null, { body: {} })).status).toBe(401);
  });
  test("agent tokens cannot use it", async () => {
    expect((await req("/v1/test-call", botToken, { body: {} })).status).toBe(403);
  });
  test("reuses one agent and follows the rate limit", async () => {
    for (let i = 0; i < 6; i++) expect((await req("/v1/test-call", devToken, { body: {} })).status).toBe(202);
    expect((await req("/v1/test-call", devToken, { body: {} })).status).toBe(429);
  });
  test("the name is reserved and does not count toward the agent limit", async () => {
    await req("/v1/test-call", devToken, { body: {} });
    expect(store.countBots(accountId)).toBe(2);
    expect((await req("/v1/bots", devToken, { body: { name: "Test call" } })).status).toBe(400);
  });
});

describe("placing calls", () => {
  test("rings the phone and reports push state", async () => {
    const res = await req("/v1/call", botToken, { body: { text: "Production is down", title: "Incident" } });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ push: "sent", status: "ringing", bot_name: "Bot" });
    expect(sent[0]?.device.voip_token).toBe(VOIP);
  });
  test("reports an account with no phone", async () => {
    const lonely = store.createAccount(clock);
    const { token } = store.addBot({ accountId: lonely.id, name: "Bot" });
    expect(await (await req("/v1/call", token, { body: {} })).json()).toMatchObject({ push: "no_device" });
  });
  test("a call without any message just rings", async () => {
    for (const init of [{ method: "POST" }, { body: {} }, { body: { title: "Incident" } }]) {
      const res = await req("/v1/call", botToken, init);
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ text: null, has_audio: false, status: "ringing" });
    }
    expect(sent).toHaveLength(3);
  });
  test("refuses text and audio together", async () => {
    expect((await req("/v1/call", botToken, { body: { text: "x", ...audioCall } })).status).toBe(400);
  });
  test("limits text length and audio type", async () => {
    expect((await req("/v1/call", botToken, { body: { text: "x".repeat(MAX_TEXT + 1) } })).status).toBe(400);
    expect((await req("/v1/call", botToken, { body: { audio_base64: "AAAA", audio_mime: "text/html" } })).status).toBe(400);
  });
  test("stores and serves audio to the phone only", async () => {
    const id = await place(botToken, audioCall);
    const res = await req(`/v1/calls/${id}/audio`, devToken);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(await res.text()).toBe("fake-mp3");
    expect((await req(`/v1/calls/${id}/audio`, botToken)).status).toBe(403);
  });
  test("accepts any text: no stress, no language, unknown language", async () => {
    const plain = await req("/v1/call", botToken, { body: { text: "Привет", language: "ru" } });
    expect(plain.status).toBe(202);
    expect(await plain.json()).toMatchObject({ language: "ru", status: "ringing" });
    expect(await (await req("/v1/call", botToken, { body: { text: "Привет" } })).json()).toMatchObject({ language: null });
    expect(await (await req("/v1/call", botToken, { body: { text: "Привет", language: "xx" } })).json()).toMatchObject({ language: null });
  });
  test("idempotency key does not ring twice", async () => {
    const first = await place(botToken, { text: "x", idempotency_key: "k" });
    const res = await req("/v1/call", botToken, { body: { text: "x", idempotency_key: "k" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: first, deduplicated: true });
    expect(sent).toHaveLength(1);
  });
  test("rate limits per agent", async () => {
    for (let i = 0; i < 6; i++) expect((await req("/v1/call", botToken, { body: { text: `${i}` } })).status).toBe(202);
    expect((await req("/v1/call", botToken, { body: { text: "7" } })).status).toBe(429);
    expect((await req("/v1/call", chatBotToken, { body: { text: "other" } })).status).toBe(202);
    clock += 61_000;
    expect((await req("/v1/call", botToken, { body: { text: "later" } })).status).toBe(202);
  });
  test("limits calls per account per day", async () => {
    for (let i = 0; i < CALLS_PER_DAY; i++) store.createCall({ botId, text: "x", now: clock - 3_600_000 });
    expect((await req("/v1/call", botToken, { body: { text: "x" } })).status).toBe(429);
    expect((await req("/v1/call", otherBot, { body: { text: "x" } })).status).toBe(202);
  });
  test("clears phone token when APNs says it is dead", async () => {
    pushResult = { ok: false, status: 410, reason: "Unregistered", invalidToken: true };
    expect(await (await req("/v1/call", botToken, { body: { text: "x" } })).json()).toMatchObject({ push: "failed" });
    expect(store.listDevices(accountId)[0]?.voip_token).toBeNull();
  });
});

describe("cleanup", () => {
  test("audio is removed after a day and abandoned accounts after a week", async () => {
    const id = await place(botToken, audioCall);
    const empty = store.createAccount(clock);
    clock += 25 * 60 * 60 * 1000;
    app.purge();
    expect(existsSync(join(dir, "audio", id))).toBe(false);
    expect(store.accountExists(empty.id)).toBe(true);
    clock += 7 * 24 * 60 * 60 * 1000;
    app.purge();
    expect(store.accountExists(empty.id)).toBe(false);
    expect(store.accountExists(accountId)).toBe(true);
  });
});

describe("call lifecycle", () => {
  const setStatus = (id: string, status: string) => req(`/v1/calls/${id}/status`, devToken, { body: { status } });

  test("ringing → answered → played", async () => {
    const id = await place();
    expect((await setStatus(id, "answered")).status).toBe(200);
    expect((await setStatus(id, "played")).status).toBe(200);
    expect(store.call(id)?.status).toBe("played");
  });
  test("rejects transitions out of finished calls but tolerates repeats", async () => {
    const id = await place();
    await setStatus(id, "declined");
    expect((await setStatus(id, "declined")).status).toBe(200);
    expect((await setStatus(id, "answered")).status).toBe(409);
    expect((await setStatus(id, "played")).status).toBe(409);
  });
  test("cannot mark played without answering", async () => {
    expect((await setStatus(await place(), "played")).status).toBe(409);
  });
  test("unanswered calls expire and leave pending", async () => {
    const id = await place();
    let pending = (await (await req("/v1/calls/pending", devToken)).json()) as { calls: unknown[] };
    expect(pending.calls).toHaveLength(1);
    clock += RING_TIMEOUT_MS + 1;
    pending = (await (await req("/v1/calls/pending", devToken)).json()) as { calls: unknown[] };
    expect(pending.calls).toHaveLength(0);
    expect(store.call(id)?.status).toBe("missed");
  });
});

describe("capabilities and chat", () => {
  test("agents advertise chat only when configured", async () => {
    const { bots } = (await (await req("/v1/bots", devToken)).json()) as { bots: { name: string; capabilities: { chat: boolean } }[] };
    expect(bots.find((b) => b.name === "Bot")?.capabilities.chat).toBe(false);
    expect(bots.find((b) => b.name === "Chatty")?.capabilities.chat).toBe(true);
    expect(JSON.stringify(bots)).not.toContain("HERMES_KEY");
  });
  test("chat is refused for call-only agent", async () => {
    expect((await req(`/v1/bots/${botId}/chat`, devToken, { body: { messages: [{ role: "user", content: "x" }] } })).status).toBe(409);
  });
  test("proxies chat with server-side key and streams", async () => {
    const res = await req(`/v1/bots/${chatBotId}/chat`, devToken, { body: { messages: [{ role: "user", content: "hello" }] } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toContain("[DONE]");
    expect(upstream?.url).toBe("http://hermes/v1/chat/completions");
    expect((upstream?.init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect(JSON.parse(upstream?.init.body as string)).toMatchObject({ model: "hermes-agent", stream: true });
  });
  test("phone cannot inject a system prompt", async () => {
    const res = await req(`/v1/bots/${chatBotId}/chat`, devToken, { body: { messages: [{ role: "system", content: "x" }] } });
    expect(res.status).toBe(400);
    expect(upstream).toBeNull();
  });
});

describe("mcp", () => {
  const rpc = (method: string, params?: unknown, id: number | undefined = 1) =>
    req("/mcp", botToken, { body: { jsonrpc: "2.0", id, method, params } });

  test("initialize negotiates version", async () => {
    const body = (await (await rpc("initialize", { protocolVersion: "2025-03-26" })).json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe("2025-03-26");
  });
  test("lists annotated tools", async () => {
    const body = (await (await rpc("tools/list")).json()) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
    expect(body.result.tools.map((t) => [t.name, t.annotations.readOnlyHint])).toEqual([["phone_call", false], ["phone_call_status", true]]);
  });
  test("phone_call rings and status reads back", async () => {
    const body = (await (await rpc("tools/call", { name: "phone_call", arguments: { text: "Hello" } })).json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(false);
    expect(sent).toHaveLength(1);
    const { id } = JSON.parse(body.result.content[0]!.text) as { id: string };
    const status = (await (await rpc("tools/call", { name: "phone_call_status", arguments: { id } })).json()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(status.result.content[0]!.text).status).toBe("ringing");
  });
  test("phone_call without arguments just rings", async () => {
    const body = (await (await rpc("tools/call", { name: "phone_call", arguments: {} })).json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(false);
    expect(sent).toHaveLength(1);
  });
  test("tool errors are reported as isError", async () => {
    const body = (await (await rpc("tools/call", { name: "phone_call", arguments: { text: "x".repeat(MAX_TEXT + 1) } })).json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
  });
  test("notifications get 202 without body", async () => {
    expect((await req("/mcp", botToken, { body: { jsonrpc: "2.0", method: "notifications/initialized" } })).status).toBe(202);
  });
  test("unknown method errors", async () => {
    const body = (await (await rpc("nope")).json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });
});

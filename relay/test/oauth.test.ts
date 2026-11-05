import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { Store } from "../src/db";
import { createOAuth, isAllowedRedirect } from "../src/oauth";

const BASE = "https://relay.test/herb";
const ORIGIN = "https://relay.test";
const REDIRECT = "http://127.0.0.1:5000/callback";
const VERIFIER = "v".repeat(50);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let store: Store;
let clock: number;
let app: ReturnType<typeof createApp>;
let deviceId: string;
let deviceToken: string;
let oauth: ReturnType<typeof createOAuth>;

const call = (path: string, init: RequestInit = {}) => app.handle(new Request(`http://internal${path}`, init));
const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data).toString(),
});

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "herb-oauth-"));
  store = new Store(join(dir, "t.sqlite"));
  clock = 1_000_000;
  oauth = createOAuth({ store, publicUrl: BASE, now: () => clock });
  app = createApp({ store, dataDir: dir, push: null, oauth, now: () => clock });
  const device = store.addDevice("iPhone");
  deviceId = device.id;
  deviceToken = device.token;
});

async function connectCode(token = deviceToken) {
  const res = await call("/v1/connect-codes", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { code: string }).code;
}

async function registerClient(name = "Codex", uris = [REDIRECT]) {
  const res = await call("/register", { method: "POST", body: JSON.stringify({ client_name: name, redirect_uris: uris }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function openLogin(clientId: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE,
    code_challenge_method: "S256", state: "st", ...extra,
  });
  const res = await call(`/authorize?${q}`);
  const html = await res.text();
  return {
    res,
    html,
    pending: /name="pending" value="([^"]+)"/.exec(html)?.[1] ?? "",
    csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "",
  };
}

async function submit(login: { pending: string; csrf: string }, fields: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const code = fields.code ?? (await connectCode());
  return call("/authorize", {
    method: "POST",
    headers: { origin: ORIGIN, cookie: `herb_login=${login.csrf}`, ...headers },
    body: new URLSearchParams({ pending: login.pending, csrf: login.csrf, bot_name: "Codex", code, ...fields }).toString(),
  });
}

async function authorize(clientId: string, fields: Record<string, string> = {}) {
  const res = await submit(await openLogin(clientId), fields);
  expect(res.status).toBe(200);
  const target = new URL(res.headers.get("refresh")!.slice("0;url=".length));
  expect(target.searchParams.get("state")).toBe("st");
  return target.searchParams.get("code")!;
}

const exchange = (clientId: string, code: string, extra: Record<string, string> = {}) =>
  call("/token", form({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: VERIFIER, redirect_uri: REDIRECT, ...extra }));

async function tokens(clientId: string) {
  const res = await exchange(clientId, await authorize(clientId));
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string };
}

const refresh = (clientId: string, token: string) =>
  call("/token", form({ grant_type: "refresh_token", client_id: clientId, refresh_token: token }));

const mcp = (token: string) =>
  call("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "phone_call", arguments: { text: "Приве́т", language: "ru" } } }),
  });

describe("discovery", () => {
  test("unauthenticated MCP points to resource metadata", async () => {
    const res = await call("/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`${ORIGIN}/.well-known/oauth-protected-resource/herb/mcp`);
  });
  test("metadata links resource and server", async () => {
    const prm = await (await call("/.well-known/oauth-protected-resource/herb/mcp")).json() as { resource: string; authorization_servers: string[] };
    expect(prm.resource).toBe(`${BASE}/mcp`);
    const as = await (await call("/.well-known/oauth-authorization-server/herb")).json() as { issuer: string; token_endpoint: string; code_challenge_methods_supported: string[] };
    expect(prm.authorization_servers).toEqual([as.issuer]);
    expect(as.token_endpoint).toBe(`${BASE}/token`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  });
});

describe("redirect rules", () => {
  test.each([
    ["https://app.test/cb", true], ["http://127.0.0.1:1/cb", true], ["http://localhost:1/cb", true], ["cursor://oauth/cb", true],
    ["http://evil.test/cb", false], ["javascript:alert(1)", false], ["data:text/html,x", false], ["https://a.test/#f", false], ["nonsense", false],
  ])("%s → %p", (uri, allowed) => {
    expect(isAllowedRedirect(uri)).toBe(allowed);
  });
  test("registration rejects bad redirect", async () => {
    const res = await call("/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }) });
    expect(res.status).toBe(400);
  });
});

describe("authorization", () => {
  test("full flow creates bot, MCP call works and shows under that bot", async () => {
    const client = await registerClient("Grok Bot");
    const res = await exchange(client, await authorize(client, { bot_name: "Grok" }));
    const { access_token } = (await res.json()) as { access_token: string };
    const reply = await mcp(access_token);
    expect(reply.status).toBe(200);
    expect(store.botByName(deviceId, "Grok")).not.toBeNull();
    expect(store.listCalls(deviceId, 5)[0]?.bot_name).toBe("Grok");
  });
  test("unknown client or foreign redirect never redirects", async () => {
    const q = new URLSearchParams({ response_type: "code", client_id: "nope", redirect_uri: "https://evil.test/", code_challenge: CHALLENGE, code_challenge_method: "S256" });
    const res = await call(`/authorize?${q}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const client = await registerClient();
    const foreign = await openLogin(client, { redirect_uri: "https://evil.test/" });
    expect(foreign.res.status).toBe(400);
    expect(foreign.res.headers.get("location")).toBeNull();
  });
  test("loopback port may differ, path may not", async () => {
    const client = await registerClient();
    expect((await openLogin(client, { redirect_uri: "http://127.0.0.1:7777/callback" })).res.status).toBe(200);
    expect((await openLogin(client, { redirect_uri: "http://127.0.0.1:7777/other" })).res.status).toBe(400);
  });
  test("PKCE is mandatory", async () => {
    const client = await registerClient();
    const { res } = await openLogin(client, { code_challenge_method: "plain" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });
  test("wrong resource is refused", async () => {
    const client = await registerClient();
    expect((await openLogin(client, { resource: "https://other.test/mcp" })).res.status).toBe(302);
    expect((await openLogin(client, { resource: `${BASE}/mcp` })).res.status).toBe(200);
  });
  test("wrong code creates nothing", async () => {
    const res = await submit(await openLogin(await registerClient()), { code: "WRONG234", bot_name: "Evil" });
    expect(res.status).toBe(400);
    expect(res.headers.get("refresh")).toBeNull();
    expect(store.botByName(deviceId, "Evil")).toBeNull();
  });
  test("code is single use and expires", async () => {
    const client = await registerClient();
    const code = await connectCode();
    expect((await submit(await openLogin(client), { code })).status).toBe(200);
    expect((await submit(await openLogin(client), { code })).status).toBe(400);
    const late = await connectCode();
    clock += 11 * 60 * 1000;
    expect((await submit(await openLogin(client), { code: late })).status).toBe(400);
  });
  test("code works however it is typed", async () => {
    const client = await registerClient();
    const code = await connectCode();
    expect((await submit(await openLogin(client), { code: ` ${code.toLowerCase().replace("-", " ")} ` })).status).toBe(200);
  });
  test("a code connects the agent to the account that issued it", async () => {
    const other = store.addDevice("Other");
    const client = await registerClient();
    const code = await connectCode(other.token);
    expect((await submit(await openLogin(client), { code, bot_name: "Mine" })).status).toBe(200);
    expect(store.botByName(other.id, "Mine")).not.toBeNull();
    expect(store.botByName(deviceId, "Mine")).toBeNull();
  });
  test("a new code replaces the previous one", async () => {
    const client = await registerClient();
    const first = await connectCode();
    await connectCode();
    expect((await submit(await openLogin(client), { code: first })).status).toBe(400);
  });
  test("works on a server at the domain root", async () => {
    const root = createOAuth({ store, publicUrl: ORIGIN, now: () => clock });
    const as = await (await root.handle(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), new URL(`${ORIGIN}/.well-known/oauth-authorization-server`)))!.json() as { issuer: string; token_endpoint: string };
    expect(as.issuer).toBe(ORIGIN);
    expect(as.token_endpoint).toBe(`${ORIGIN}/token`);
    expect(root.challengeHeader).toContain(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
  });
  test("cross-origin and missing CSRF are refused", async () => {
    const client = await registerClient();
    expect((await submit(await openLogin(client), {}, { origin: "https://evil.test" })).status).toBe(403);
    expect((await submit(await openLogin(client), {}, { cookie: "herb_login=other" })).status).toBe(400);
    expect((await submit(await openLogin(client), { csrf: "other" })).status).toBe(400);
  });
  test("code attempts are limited per address, not for everyone", async () => {
    const client = await registerClient();
    const attacker = { "cf-connecting-ip": "203.0.113.9" };
    const login = await openLogin(client);
    for (let i = 0; i < 10; i++) await submit(login, { code: "WRONG234" }, attacker);
    expect((await submit(login, {}, attacker)).status).toBe(429);
    expect((await submit(await openLogin(client), {}, { "cf-connecting-ip": "203.0.113.10" })).status).toBe(200);
    clock += 16 * 60 * 1000;
    expect((await submit(await openLogin(client), {}, attacker)).status).toBe(200);
  });
  test("client name cannot inject HTML", async () => {
    const { html } = await openLogin(await registerClient(`<script>alert(1)</script>`));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("tokens", () => {
  test("code is single use, even after a failed attempt", async () => {
    const client = await registerClient();
    const code = await authorize(client);
    expect((await exchange(client, code, { code_verifier: "w".repeat(50) })).status).toBe(400);
    expect((await exchange(client, code)).status).toBe(400);
  });
  test("code is bound to client and redirect, and expires", async () => {
    const client = await registerClient();
    const other = await registerClient("Other");
    expect((await exchange(other, await authorize(client))).status).toBe(400);
    expect((await exchange(client, await authorize(client), { redirect_uri: "http://127.0.0.1:1/x" })).status).toBe(400);
    const code = await authorize(client);
    clock += 6 * 60 * 1000;
    expect((await exchange(client, code)).status).toBe(400);
  });
  test("access token expires and refresh rotates", async () => {
    const client = await registerClient();
    const first = await tokens(client);
    clock += 61 * 60 * 1000;
    expect((await mcp(first.access_token)).status).toBe(401);
    const res = await refresh(client, first.refresh_token);
    expect(res.status).toBe(200);
    const second = (await res.json()) as { access_token: string; refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await mcp(second.access_token)).status).toBe(200);
  });
  test("reusing an old refresh token revokes the grant", async () => {
    const client = await registerClient();
    const first = await tokens(client);
    const second = (await (await refresh(client, first.refresh_token)).json()) as { access_token: string; refresh_token: string };
    expect((await refresh(client, first.refresh_token)).status).toBe(400);
    expect((await mcp(second.access_token)).status).toBe(401);
    expect((await refresh(client, second.refresh_token)).status).toBe(400);
  });
  test("revoke cuts access", async () => {
    const client = await registerClient();
    const { access_token } = await tokens(client);
    expect((await call("/revoke", form({ token: access_token }))).status).toBe(200);
    expect((await mcp(access_token)).status).toBe(401);
  });
  test("OAuth token cannot use device routes", async () => {
    const { access_token } = await tokens(await registerClient());
    const res = await call("/v1/bots", { headers: { authorization: `Bearer ${access_token}` } });
    expect(res.status).toBe(403);
  });
  test("removing the bot removes its access", async () => {
    const { access_token } = await tokens(await registerClient());
    store.deleteBot(store.botByName(deviceId, "Codex")!.id);
    expect((await mcp(access_token)).status).toBe(401);
  });
});

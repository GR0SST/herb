import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { Store } from "../src/db";
import { createOAuth, isAllowedRedirect } from "../src/oauth";

const ORIGIN = "https://relay.test";
const BASE = ORIGIN;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(50);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let store: Store;
let clock: number;
let app: ReturnType<typeof createApp>;
let accountId: string;
let accountKey: string;

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
  const oauth = createOAuth({ store, publicUrl: BASE, now: () => clock });
  app = createApp({ store, dataDir: dir, push: null, oauth, publicUrl: BASE, now: () => clock });
  const account = store.createAccount(clock);
  accountId = account.id;
  accountKey = account.key;
});

async function registerClient(name = "Claude", uris = [REDIRECT]) {
  const res = await call("/register", { method: "POST", body: JSON.stringify({ client_name: name, redirect_uris: uris }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

interface Browser {
  cookies: Map<string, string>;
  pending: string;
  csrf: string;
  html: string;
  res: Response;
}

function absorb(browser: Browser, res: Response, html: string) {
  for (const value of res.headers.getSetCookie()) {
    const [pair] = value.split(";");
    const [name, cookieValue] = pair!.split("=") as [string, string];
    if (cookieValue) browser.cookies.set(name, cookieValue);
    else browser.cookies.delete(name);
  }
  browser.res = res;
  browser.html = html;
  browser.pending = /name="pending" value="([^"]+)"/.exec(html)?.[1] ?? browser.pending;
  browser.csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? browser.csrf;
}

const cookieHeader = (browser: Browser) => [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");

async function open(clientId: string, extra: Record<string, string> = {}, cookies = new Map<string, string>()) {
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE,
    code_challenge_method: "S256", state: "st", ...extra,
  });
  const browser: Browser = { cookies, pending: "", csrf: "", html: "", res: null as unknown as Response };
  const res = await call(`/authorize?${q}`, { headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
  absorb(browser, res, await res.text());
  return browser;
}

async function post(browser: Browser, action: string, fields: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const res = await call("/authorize", {
    method: "POST",
    headers: { origin: ORIGIN, cookie: cookieHeader(browser), ...headers },
    body: new URLSearchParams({ pending: browser.pending, csrf: browser.csrf, action, ...fields }).toString(),
  });
  absorb(browser, res, await res.text());
  return res;
}

async function authorize(clientId: string, botName = "Claude") {
  const browser = await open(clientId);
  await post(browser, "signin", { key: accountKey });
  const res = await post(browser, "approve", { bot_name: botName });
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
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "phone_call", arguments: { text: "Hello" } } }),
  });

describe("discovery", () => {
  test("unauthenticated MCP points to resource metadata", async () => {
    const res = await call("/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
  });
  test("metadata links resource and server at the domain root", async () => {
    const prm = (await (await call("/.well-known/oauth-protected-resource/mcp")).json()) as { resource: string; authorization_servers: string[] };
    expect(prm.resource).toBe(`${BASE}/mcp`);
    const as = (await (await call("/.well-known/oauth-authorization-server")).json()) as { issuer: string; token_endpoint: string; registration_endpoint: string; code_challenge_methods_supported: string[] };
    expect(prm.authorization_servers).toEqual([as.issuer]);
    expect(as.issuer).toBe(ORIGIN);
    expect(as.token_endpoint).toBe(`${BASE}/token`);
    expect(as.registration_endpoint).toBe(`${BASE}/register`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  });
  test("works under a path prefix too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herb-oauth-"));
    const prefixed = createOAuth({ store, publicUrl: `${ORIGIN}/herb`, now: () => clock });
    const other = createApp({ store, dataDir: dir, push: null, oauth: prefixed, publicUrl: `${ORIGIN}/herb` });
    const as = (await (await other.handle(new Request("http://internal/.well-known/oauth-authorization-server/herb"))).json()) as { token_endpoint: string };
    expect(as.token_endpoint).toBe(`${ORIGIN}/herb/token`);
  });
});

describe("redirect rules", () => {
  test.each([
    ["https://claude.ai/api/mcp/auth_callback", true], ["https://chatgpt.com/connector_platform_oauth_redirect", true],
    ["http://127.0.0.1:1/cb", true], ["http://localhost:1/cb", true], ["cursor://oauth/cb", true],
    ["http://evil.test/cb", false], ["javascript:alert(1)", false], ["data:text/html,x", false], ["https://a.test/#f", false], ["nonsense", false],
  ])("%s → %p", (uri, allowed) => {
    expect(isAllowedRedirect(uri)).toBe(allowed);
  });
  test("registration rejects a bad redirect", async () => {
    const res = await call("/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }) });
    expect(res.status).toBe(400);
  });
});

describe("authorization", () => {
  test("sign in with a key, connect, and the MCP call lands on that account", async () => {
    const client = await registerClient("ChatGPT");
    const res = await exchange(client, await authorize(client, "ChatGPT"));
    const { access_token } = (await res.json()) as { access_token: string };
    expect((await mcp(access_token)).status).toBe(200);
    expect(store.botByName(accountId, "ChatGPT")).not.toBeNull();
    expect(store.listCalls(accountId, 5)[0]?.bot_name).toBe("ChatGPT");
  });
  test("a new user can create an account on the sign-in page", async () => {
    const client = await registerClient();
    const browser = await open(client);
    expect(browser.html).toContain("Create Account");
    const created = await post(browser, "create");
    expect(created.status).toBe(200);
    const key = /<p class="key">([^<]+)<\/p>/.exec(browser.html)?.[1];
    expect(key).toBeTruthy();
    const res = await post(browser, "approve", { bot_name: "Claude" });
    const code = new URL(res.headers.get("refresh")!.slice(6)).searchParams.get("code")!;
    const { access_token } = (await (await exchange(client, code)).json()) as { access_token: string };
    expect((await mcp(access_token)).status).toBe(200);
    const newAccount = store.accountIdByKey(key!)!;
    expect(store.botByName(newAccount, "Claude")).not.toBeNull();
    expect(store.botByName(accountId, "Claude")).toBeNull();
  });
  test("a signed-in browser skips the key", async () => {
    const client = await registerClient();
    const first = await open(client);
    await post(first, "signin", { key: accountKey });
    const second = await open(client, {}, first.cookies);
    expect(second.html).toContain('value="approve"');
    expect(second.html).not.toContain('name="key"');
  });
  test("another account can be used instead", async () => {
    const client = await registerClient();
    const browser = await open(client);
    await post(browser, "signin", { key: accountKey });
    await post(browser, "signout");
    expect(browser.html).toContain('name="key"');
    expect(browser.cookies.has("herb_session")).toBe(false);
  });
  test("approving without signing in is refused", async () => {
    const client = await registerClient();
    const browser = await open(client);
    const res = await post(browser, "approve", { bot_name: "Evil" });
    expect(res.status).toBe(400);
    expect(res.headers.get("refresh")).toBeNull();
    expect(store.botByName(accountId, "Evil")).toBeNull();
  });
  test("a wrong key connects nothing", async () => {
    const client = await registerClient();
    const browser = await open(client);
    const res = await post(browser, "signin", { key: "WRONG-KEY" });
    expect(res.status).toBe(400);
    expect(browser.html).toContain("Wrong account key");
    expect(browser.cookies.has("herb_session")).toBe(false);
  });
  test("key attempts are limited per address, not for everyone", async () => {
    const client = await registerClient();
    const attacker = { "cf-connecting-ip": "203.0.113.9" };
    const browser = await open(client);
    for (let i = 0; i < 10; i++) await post(browser, "signin", { key: "WRONG" }, attacker);
    await post(browser, "signin", { key: accountKey }, attacker);
    expect(browser.html).toContain("Too many attempts");
    const fresh = await open(client);
    await post(fresh, "signin", { key: accountKey }, { "cf-connecting-ip": "203.0.113.10" });
    expect(fresh.cookies.has("herb_session")).toBe(true);
  });
  test("unknown client or foreign redirect never redirects", async () => {
    const q = new URLSearchParams({ response_type: "code", client_id: "nope", redirect_uri: "https://evil.test/", code_challenge: CHALLENGE, code_challenge_method: "S256" });
    const res = await call(`/authorize?${q}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const foreign = await open(await registerClient(), { redirect_uri: "https://evil.test/" });
    expect(foreign.res.status).toBe(400);
    expect(foreign.res.headers.get("location")).toBeNull();
  });
  test("loopback port may differ, path may not", async () => {
    const client = await registerClient("Codex", ["http://127.0.0.1:5000/callback"]);
    expect((await open(client, { redirect_uri: "http://127.0.0.1:7777/callback" })).res.status).toBe(200);
    expect((await open(client, { redirect_uri: "http://127.0.0.1:7777/other" })).res.status).toBe(400);
  });
  test("PKCE is mandatory", async () => {
    const { res } = await open(await registerClient(), { code_challenge_method: "plain" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });
  test("a foreign resource is refused, ours with or without slash is fine", async () => {
    const client = await registerClient();
    expect((await open(client, { resource: "https://other.test/mcp" })).res.status).toBe(302);
    expect((await open(client, { resource: `${BASE}/mcp` })).res.status).toBe(200);
    expect((await open(client, { resource: `${BASE}/mcp/` })).res.status).toBe(200);
  });
  test("cross-origin and bad CSRF are refused", async () => {
    const client = await registerClient();
    expect((await post(await open(client), "signin", { key: accountKey }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await post(await open(client), "signin", { key: accountKey }, { cookie: "herb_login=other" })).status).toBe(400);
    expect((await post(await open(client), "signin", { key: accountKey, csrf: "other" })).status).toBe(400);
  });
  test("client name cannot inject HTML", async () => {
    const { html } = await open(await registerClient("<script>alert(1)</script>"));
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
    expect((await exchange(client, await authorize(client), { redirect_uri: "https://claude.com/x" })).status).toBe(400);
    const code = await authorize(client);
    clock += 6 * 60 * 1000;
    expect((await exchange(client, code)).status).toBe(400);
  });
  test("a deleted client gets 401 invalid_client so it can register again", async () => {
    const res = await exchange("deleted-client", "x");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_client" });
  });
  test("client id may come through Basic auth", async () => {
    const client = await registerClient();
    const code = await authorize(client);
    const res = await call("/token", {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${client}:`).toString("base64")}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: VERIFIER, redirect_uri: REDIRECT }).toString(),
    });
    expect(res.status).toBe(200);
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
  test("OAuth token cannot use account routes", async () => {
    const { access_token } = await tokens(await registerClient());
    expect((await call("/v1/bots", { headers: { authorization: `Bearer ${access_token}` } })).status).toBe(403);
  });
  test("removing the agent removes its access", async () => {
    const { access_token } = await tokens(await registerClient());
    store.deleteBot(store.botByName(accountId, "Claude")!.id);
    expect((await mcp(access_token)).status).toBe(401);
  });
});

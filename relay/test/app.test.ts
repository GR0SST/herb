import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushResult, PushSender } from "../src/apns";
import { CALLS_PER_DAY, createApp, MAX_TEXT, REGISTRATIONS_PER_IP_HOUR } from "../src/app";
import { type Call, type Device, RING_TIMEOUT_MS, Store } from "../src/db";

const VOIP = "ab".repeat(32);
let store: Store;
let dir: string;
let clock: number;
let sent: { device: Device; call: Call }[];
let pushResult: PushResult;
let app: ReturnType<typeof createApp>;
let upstream: { url: string; init: RequestInit } | null;
let devToken: string;
let deviceId: string;
let botToken: string;
let botId: string;
let hermesId: string;
let hermesToken: string;
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
    publicUrl: "https://relay.test",
    env: { HERMES_KEY: "secret-key" },
    fetchImpl: (async (url: string, init: RequestInit) => {
      upstream = { url, init };
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n", { status: 200 });
    }) as unknown as typeof fetch,
  });
  const device = store.addDevice("iPhone");
  devToken = device.token;
  deviceId = device.id;
  store.setVoipToken(device.id, VOIP, "sandbox");
  const grok = store.addBot({ deviceId, name: "Grok" });
  botToken = grok.token;
  botId = grok.id;
  const hermes = store.addBot({ deviceId, name: "Hermes", chatUrl: "http://hermes/v1/", chatKeyEnv: "HERMES_KEY", chatModel: "hermes-agent" });
  hermesId = hermes.id;
  hermesToken = hermes.token;
  const other = store.addDevice("Other phone");
  otherDev = other.token;
  store.setVoipToken(other.id, "cd".repeat(32), "production");
  otherBot = store.addBot({ deviceId: other.id, name: "Other agent" }).token;
});

describe("auth", () => {
  test("rejects missing and wrong tokens", async () => {
    expect((await req("/v1/bots", null)).status).toBe(401);
    expect((await req("/v1/bots", "nope")).status).toBe(401);
    expect((await req("/mcp", devToken, { body: {} })).status).toBe(401);
  });
  test("bot token cannot read device routes", async () => {
    expect((await req("/v1/bots", botToken)).status).toBe(403);
  });
  test("device token cannot place calls", async () => {
    expect((await req("/v1/call", devToken, { body: { text: "x" } })).status).toBe(404);
    expect(sent).toHaveLength(0);
  });
  test("bot cannot read another bot's call", async () => {
    const id = await place();
    expect((await req(`/v1/calls/${id}`, hermesToken)).status).toBe(404);
    expect((await req(`/v1/calls/${id}`, botToken)).status).toBe(200);
  });
});

describe("accounts are isolated", () => {
  test("registering creates an empty account", async () => {
    const res = await req("/v1/register", null, { method: "POST" });
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    const { bots } = (await (await req("/v1/bots", token)).json()) as { bots: unknown[] };
    expect(bots).toHaveLength(0);
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
    const id = await place(botToken, { audio_base64: Buffer.from("x").toString("base64"), audio_mime: "audio/mpeg" });
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
    const res = await req(`/v1/bots/${hermesId}/chat`, otherDev, { body: { messages: [{ role: "user", content: "x" }] } });
    expect(res.status).toBe(404);
    expect(upstream).toBeNull();
  });
  test("a call rings only the owner's phone", async () => {
    await place(botToken);
    expect(sent.map((s) => s.device.voip_token)).toEqual([VOIP]);
    sent = [];
    await place(otherBot);
    expect(sent.map((s) => s.device.voip_token)).toEqual(["cd".repeat(32)]);
  });
  test("two accounts can use the same agent name", async () => {
    const res = await req("/v1/bots", otherDev, { body: { name: "Grok" } });
    expect(res.status).toBe(201);
  });
  test("registration is limited per address", async () => {
    const headers = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < REGISTRATIONS_PER_IP_HOUR; i++) expect((await req("/v1/register", null, { method: "POST", headers })).status).toBe(201);
    expect((await req("/v1/register", null, { method: "POST", headers })).status).toBe(429);
    expect((await req("/v1/register", null, { method: "POST", headers: { "cf-connecting-ip": "203.0.113.10" } })).status).toBe(201);
    clock += 61 * 60 * 1000;
    expect((await req("/v1/register", null, { method: "POST", headers })).status).toBe(201);
  });
  test("closed registration refuses new accounts", async () => {
    app = createApp({ store, dataDir: dir, push: null, openRegistration: false });
    expect((await req("/v1/register", null, { method: "POST" })).status).toBe(403);
  });
  test("deleting an account removes its data and audio", async () => {
    const id = await place(botToken, { audio_base64: Buffer.from("x").toString("base64"), audio_mime: "audio/mpeg" });
    const path = join(dir, "audio", id);
    expect(existsSync(path)).toBe(true);
    expect((await req("/v1/device", devToken, { method: "DELETE" })).status).toBe(204);
    expect(store.call(id)).toBeNull();
    expect(store.bot(botId)).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect((await req("/v1/bots", devToken)).status).toBe(401);
    expect((await req("/v1/bots", otherDev)).status).toBe(200);
  });
});

describe("agents", () => {
  test("create returns a working token once", async () => {
    const res = await req("/v1/bots", devToken, { body: { name: "Codex" } });
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    expect((await req("/v1/call", token, { body: { text: "x" } })).status).toBe(202);
    const { bots } = (await (await req("/v1/bots", devToken)).json()) as { bots: object[] };
    expect(JSON.stringify(bots)).not.toContain("herb_bot_");
  });
  test("rejects bad and duplicate names", async () => {
    expect((await req("/v1/bots", devToken, { body: { name: " " } })).status).toBe(400);
    expect((await req("/v1/bots", devToken, { body: { name: "x".repeat(41) } })).status).toBe(400);
    expect((await req("/v1/bots", devToken, { body: { name: "Grok" } })).status).toBe(409);
  });
  test("delete cuts off the agent token", async () => {
    expect((await req(`/v1/bots/${botId}`, devToken, { method: "DELETE" })).status).toBe(204);
    expect((await req("/v1/call", botToken, { body: { text: "x" } })).status).toBe(401);
  });
});

describe("placing calls", () => {
  test("rings device and reports push state", async () => {
    const res = await req("/v1/call", botToken, { body: { text: "Вставай", title: "Будильник" } });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ push: "sent", status: "ringing", bot_name: "Grok" });
    expect(sent[0]?.device.voip_token).toBe(VOIP);
  });
  test("a call without any message just rings", async () => {
    for (const init of [{ method: "POST" }, { body: {} }, { body: { title: "Wake up" } }]) {
      const res = await req("/v1/call", botToken, init);
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ text: null, has_audio: false, status: "ringing" });
    }
    expect(sent).toHaveLength(3);
  });
  test("refuses text and audio together", async () => {
    expect((await req("/v1/call", botToken, { body: { text: "x", audio_base64: "AAAA", audio_mime: "audio/mpeg" } })).status).toBe(400);
  });
  test("limits text length and audio type", async () => {
    expect((await req("/v1/call", botToken, { body: { text: "x".repeat(MAX_TEXT + 1) } })).status).toBe(400);
    expect((await req("/v1/call", botToken, { body: { audio_base64: "AAAA", audio_mime: "text/html" } })).status).toBe(400);
  });
  test("stores and serves audio to the device only", async () => {
    const audio = Buffer.from("fake-mp3").toString("base64");
    const id = await place(botToken, { audio_base64: audio, audio_mime: "audio/mpeg" });
    const res = await req(`/v1/calls/${id}/audio`, devToken);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(await res.text()).toBe("fake-mp3");
    expect((await req(`/v1/calls/${id}/audio`, botToken)).status).toBe(403);
  });
  test("accepts any text: no stress, no language, unknown language", async () => {
    const plain = await req("/v1/call", botToken, { body: { text: "Привет", language: "ru" } });
    expect(plain.status).toBe(202);
    expect(await plain.json()).toMatchObject({ language: "ru", status: "ringing" });
    const noLanguage = await req("/v1/call", botToken, { body: { text: "Привет" } });
    expect(noLanguage.status).toBe(202);
    expect(await noLanguage.json()).toMatchObject({ language: null });
    const unknown = await req("/v1/call", botToken, { body: { text: "Привет", language: "xx" } });
    expect(unknown.status).toBe(202);
    expect(await unknown.json()).toMatchObject({ language: null });
    expect(sent).toHaveLength(3);
  });
  test("idempotency key does not ring twice", async () => {
    const first = await place(botToken, { text: "x", idempotency_key: "k" });
    const res = await req("/v1/call", botToken, { body: { text: "x", idempotency_key: "k" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: first, deduplicated: true });
    expect(sent).toHaveLength(1);
  });
  test("rate limits per bot", async () => {
    for (let i = 0; i < 6; i++) expect((await req("/v1/call", botToken, { body: { text: `${i}` } })).status).toBe(202);
    expect((await req("/v1/call", botToken, { body: { text: "7" } })).status).toBe(429);
    expect((await req("/v1/call", hermesToken, { body: { text: "other bot" } })).status).toBe(202);
    clock += 61_000;
    expect((await req("/v1/call", botToken, { body: { text: "later" } })).status).toBe(202);
  });
  test("limits calls per account per day", async () => {
    for (let i = 0; i < CALLS_PER_DAY; i++) store.createCall({ botId, text: "x", now: clock - 3_600_000 });
    expect((await req("/v1/call", botToken, { body: { text: "x" } })).status).toBe(429);
    expect((await req("/v1/call", otherBot, { body: { text: "x" } })).status).toBe(202);
  });
  test("clears device token when APNs says it is dead", async () => {
    pushResult = { ok: false, status: 410, reason: "Unregistered", invalidToken: true };
    const body = await (await req("/v1/call", botToken, { body: { text: "x" } })).json() as { push: string };
    expect(body.push).toBe("failed");
    expect(store.device(deviceId)?.voip_token).toBeNull();
  });
});

describe("cleanup", () => {
  test("audio is removed after a day and abandoned accounts after a week", async () => {
    const id = await place(botToken, { audio_base64: Buffer.from("x").toString("base64"), audio_mime: "audio/mpeg" });
    const empty = store.registerDevice(clock);
    clock += 25 * 60 * 60 * 1000;
    app.purge();
    expect(existsSync(join(dir, "audio", id))).toBe(false);
    expect(store.device(empty.id)).not.toBeNull();
    clock += 7 * 24 * 60 * 60 * 1000;
    app.purge();
    expect(store.device(empty.id)).toBeNull();
    expect(store.device(deviceId)).not.toBeNull();
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
    let pending = await (await req("/v1/calls/pending", devToken)).json() as { calls: unknown[] };
    expect(pending.calls).toHaveLength(1);
    clock += RING_TIMEOUT_MS + 1;
    pending = await (await req("/v1/calls/pending", devToken)).json() as { calls: unknown[] };
    expect(pending.calls).toHaveLength(0);
    expect(store.call(id)?.status).toBe("missed");
  });
});

describe("capabilities and chat", () => {
  test("bots advertise chat only when configured", async () => {
    const { bots } = await (await req("/v1/bots", devToken)).json() as { bots: { name: string; capabilities: { chat: boolean } }[] };
    expect(bots.find((b) => b.name === "Grok")?.capabilities.chat).toBe(false);
    expect(bots.find((b) => b.name === "Hermes")?.capabilities.chat).toBe(true);
    expect(JSON.stringify(bots)).not.toContain("HERMES_KEY");
  });
  test("chat is refused for call-only bot", async () => {
    expect((await req(`/v1/bots/${botId}/chat`, devToken, { body: { messages: [{ role: "user", content: "x" }] } })).status).toBe(409);
  });
  test("proxies chat with server-side key and streams", async () => {
    const res = await req(`/v1/bots/${hermesId}/chat`, devToken, { body: { messages: [{ role: "user", content: "привет" }] } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toContain("[DONE]");
    expect(upstream?.url).toBe("http://hermes/v1/chat/completions");
    expect((upstream?.init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect(JSON.parse(upstream?.init.body as string)).toMatchObject({ model: "hermes-agent", stream: true });
  });
  test("device cannot inject system prompt", async () => {
    const res = await req(`/v1/bots/${hermesId}/chat`, devToken, { body: { messages: [{ role: "system", content: "x" }] } });
    expect(res.status).toBe(400);
    expect(upstream).toBeNull();
  });
});

describe("mcp", () => {
  const rpc = (method: string, params?: unknown, id: number | undefined = 1) =>
    req("/mcp", botToken, { body: { jsonrpc: "2.0", id, method, params } });

  test("initialize negotiates version", async () => {
    const body = await (await rpc("initialize", { protocolVersion: "2025-03-26" })).json() as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe("2025-03-26");
  });
  test("lists tools", async () => {
    const body = await (await rpc("tools/list")).json() as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual(["phone_call", "phone_call_status"]);
  });
  test("phone_call rings and status reads back", async () => {
    const body = await (await rpc("tools/call", { name: "phone_call", arguments: { text: "Привет" } })).json() as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(false);
    expect(sent).toHaveLength(1);
    const { id } = JSON.parse(body.result.content[0]!.text) as { id: string };
    const status = await (await rpc("tools/call", { name: "phone_call_status", arguments: { id } })).json() as { result: { content: { text: string }[] } };
    expect(JSON.parse(status.result.content[0]!.text).status).toBe("ringing");
  });
  test("phone_call without arguments just rings", async () => {
    const body = await (await rpc("tools/call", { name: "phone_call", arguments: {} })).json() as { result: { isError: boolean } };
    expect(body.result.isError).toBe(false);
    expect(sent).toHaveLength(1);
  });
  test("tool errors are reported as isError", async () => {
    const body = await (await rpc("tools/call", { name: "phone_call", arguments: { text: "x".repeat(MAX_TEXT + 1) } })).json() as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
  });
  test("notifications get 202 without body", async () => {
    const res = await req("/mcp", botToken, { body: { jsonrpc: "2.0", method: "notifications/initialized" } });
    expect(res.status).toBe(202);
  });
  test("unknown method errors", async () => {
    const body = await (await rpc("nope")).json() as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });
});

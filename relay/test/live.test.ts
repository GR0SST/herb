import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushSender } from "../src/apns";
import { createApp } from "../src/app";
import { type Call, Store } from "../src/db";
import { type CallControls, type CallSetup, isPrivateAddress, signWebhook, type VoiceEngine } from "../src/live";

const ORIGIN = "https://relay.test";
const HOOK = "https://hooks.example.com/herb";

interface Hit {
  url: string;
  headers: Headers;
  body: string;
  event: { id: string; type: string; call_id: string; data: Record<string, unknown> };
}

interface Opened {
  call: Call;
  setup: CallSetup;
  controls: CallControls;
  log: string[];
}

let store: Store;
let clock: number;
let app: ReturnType<typeof createApp>;
let hits: Hit[];
let hookReply: (hit: Hit) => Response;
let opened: Opened[];
let pushed: Call[];
let accountId: string;
let devToken: string;
let botId: string;
let botToken: string;
let otherBotToken: string;

const fakeVoice: VoiceEngine = {
  async open({ call, setup, controls, body }) {
    if (body.fail) throw new Error("model down");
    const log: string[] = [];
    opened.push({ call, setup, controls, log });
    return {
      client: { kind: "fake" },
      session: {
        say: (text, interrupt) => log.push(`say:${text}:${interrupt}`),
        addContext: (text) => log.push(`context:${text}`),
        answer: (askId, answer) => log.push(`answer:${askId}:${answer}`),
        askExpired: (askId) => log.push(`expired:${askId}`),
        hangup: (reason) => log.push(`hangup:${reason}`),
      },
    };
  },
};

const push: PushSender = {
  async send(_device, call) {
    pushed.push(call);
    return { ok: true, status: 200, invalidToken: false };
  },
};

function makeApp(options: { voice?: VoiceEngine | null; billing?: boolean } = {}) {
  app = createApp({
    store,
    dataDir: mkdtempSync(join(tmpdir(), "herb-live-")),
    push,
    now: () => clock,
    publicUrl: ORIGIN,
    voice: options.voice === undefined ? fakeVoice : options.voice,
    billing: options.billing ?? false,
    resolveHost: async (host) => (host === "internal.example.com" ? ["10.0.0.5"] : ["93.184.216.34"]),
    webhookRetryDelays: [0],
    fetchImpl: (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const body = String(init.body);
      const hit = { url, headers, body, event: JSON.parse(body) };
      hits.push(hit);
      return hookReply(hit);
    }) as unknown as typeof fetch,
  });
}

function req(path: string, token: string | null, init: { method?: string; body?: unknown } = {}) {
  return app.handle(new Request(`http://relay${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
}

async function setWebhook(url = HOOK) {
  const response = await req(`/v1/bots/${botId}`, devToken, { method: "PATCH", body: { webhook_url: url } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function callAgent(body: Record<string, unknown> = {}) {
  const response = await req("/v1/live", devToken, { body: { bot_id: botId, ...body } });
  return { status: response.status, body: (await response.json()) as { call: { id: string; status: string }; error?: { code: string } } };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const json = (body: unknown) => Response.json(body);

beforeEach(() => {
  store = new Store(":memory:");
  clock = 1_000_000;
  hits = [];
  opened = [];
  pushed = [];
  hookReply = () => new Response(null, { status: 202 });
  const account = store.createAccount(clock);
  accountId = account.id;
  const device = store.addDevice(accountId, "iPhone", clock);
  devToken = device.token;
  store.setVoipToken(device.id, "ab".repeat(32), "sandbox");
  const bot = store.addBot({ accountId, name: "Codex" });
  botId = bot.id;
  botToken = bot.token;
  const other = store.createAccount(clock);
  otherBotToken = store.addBot({ accountId: other.id, name: "Other" }).token;
  makeApp();
});

describe("agent settings", () => {
  test("webhook secret is shown once and signs events", async () => {
    const { status, body } = await setWebhook();
    expect(status).toBe(200);
    const secret = body.webhook_secret as string;
    expect(secret).toStartWith("whsec_");
    const list = (await (await req("/v1/bots", devToken)).json()) as { bots: Record<string, unknown>[] };
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(list.bots[0]!.live).toEqual({ instructions: null, webhook_url: HOOK, listener: false });

    await callAgent();
    const hit = hits[0]!;
    expect(hit.event.type).toBe("call.started");
    const timestamp = Number(hit.headers.get("herb-timestamp"));
    expect(hit.headers.get("herb-signature")).toBe(signWebhook(secret, timestamp, hit.body));
    expect(hit.headers.get("herb-event-id")).toBe(hit.event.id);
  });

  test("takes the receiving service's signing secret and signs the Standard Webhooks way", async () => {
    const own = `whsec_${Buffer.from("their-secret-key-bytes").toString("base64")}`;
    const response = await req(`/v1/bots/${botId}`, devToken, { method: "PATCH", body: { webhook_url: HOOK, webhook_secret: own } });
    expect(((await response.json()) as Record<string, unknown>).webhook_secret).toBeUndefined();
    expect(store.bot(botId)!.webhook_secret).toBe(own);

    await callAgent();
    const hit = hits[0]!;
    const id = hit.headers.get("webhook-id")!;
    const timestamp = hit.headers.get("webhook-timestamp")!;
    const expected = createHmac("sha256", Buffer.from("their-secret-key-bytes")).update(`${id}.${timestamp}.${hit.body}`).digest("base64");
    expect(hit.headers.get("webhook-signature")).toBe(`v1,${expected}`);
    expect(id).toBe(hit.event.id);

    // The secret alone can change; without a URL it cannot be set.
    expect((await req(`/v1/bots/${botId}`, devToken, { method: "PATCH", body: { webhook_secret: "another-secret" } })).status).toBe(200);
    expect(store.bot(botId)!.webhook_secret).toBe("another-secret");
    expect((await req(`/v1/bots/${botId}`, devToken, { method: "PATCH", body: { webhook_secret: "short" } })).status).toBe(400);
    await req(`/v1/bots/${botId}`, devToken, { method: "PATCH", body: { webhook_url: null } });
    expect(store.bot(botId)!.webhook_secret).toBeNull();
    expect((await req(`/v1/bots/${botId}`, devToken, { method: "PATCH", body: { webhook_secret: "another-secret" } })).status).toBe(400);
  });

  test("rejects private and non-https webhooks", async () => {
    expect((await setWebhook("http://hooks.example.com/x")).status).toBe(400);
    expect((await setWebhook("https://127.0.0.1/x")).status).toBe(400);
    expect((await setWebhook("https://internal.example.com/x")).status).toBe(400);
    expect((await setWebhook("https://user:pw@hooks.example.com/x")).status).toBe(400);
  });

  test("instructions are limited and can be cleared", async () => {
    const long = await req(`/v1/bots/${botId}`, devToken, { method: "PATCH", body: { instructions: "x".repeat(4001) } });
    expect(long.status).toBe(400);
    await req(`/v1/bots/${botId}`, devToken, { method: "PATCH", body: { instructions: "Be brief" } });
    expect(store.bot(botId)!.live_instructions).toBe("Be brief");
    await req(`/v1/bots/${botId}`, devToken, { method: "PATCH", body: { instructions: null } });
    expect(store.bot(botId)!.live_instructions).toBeNull();
  });

  test("address checks", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("starting live calls", () => {
  test("off without a speech model", async () => {
    makeApp({ voice: null });
    expect((await callAgent()).status).toBe(503);
    expect((await req("/v1/call", botToken, { body: { live: true, text: "hi" } })).status).toBe(503);
  });

  test("phone calls an agent and gets its context", async () => {
    await setWebhook();
    await req(`/v1/bots/${botId}`, devToken, { method: "PATCH", body: { instructions: "Saved rules" } });
    hookReply = () => json({ context: "Thread about billing", instructions: "Be brief", greeting: "Hi, billing thread" });
    const { status, body } = await callAgent();
    expect(status).toBe(201);
    expect(body.call.status).toBe("answered");
    expect(opened[0]!.setup).toEqual({
      direction: "inbound",
      context: "Thread about billing",
      instructions: "Saved rules\n\nBe brief",
      greeting: "Hi, billing thread",
    });
    expect(hits[0]!.event.data).toEqual({ direction: "inbound" });
  });

  test("starts without context when nobody listens", async () => {
    const { status } = await callAgent();
    expect(status).toBe(201);
    expect(opened[0]!.setup.context).toBe("");
    expect(hits).toHaveLength(0);
  });

  test("only phones, only own agents, one call at a time", async () => {
    expect((await req("/v1/live", botToken, { body: { bot_id: botId } })).status).toBe(403);
    expect((await req("/v1/live", devToken, { body: { bot_id: "nope" } })).status).toBe(404);
    expect((await callAgent()).status).toBe(201);
    expect((await callAgent()).body.error?.code).toBe("call_in_progress");
  });

  test("a failed speech model ends the call", async () => {
    const { status } = await callAgent({ fail: true });
    expect(status).toBe(502);
    expect(store.listCalls(accountId, 1)[0]!.status).toBe("failed");
    expect((await callAgent()).status).toBe(201);
  });

  test("agent calls the phone live", async () => {
    await setWebhook();
    const placed = (await (await req("/v1/call", botToken, { body: { live: true, title: "Deploy", text: "Deploy failed. Roll back?" } })).json()) as { id: string; live: boolean };
    expect(placed.live).toBe(true);
    expect(pushed[0]!.live).toBe(1);
    expect((await req("/v1/call", botToken, { body: { live: true, audio_base64: "AAAA", audio_mime: "audio/mpeg" } })).status).toBe(400);

    const answered = await req(`/v1/calls/${placed.id}/live`, devToken, { body: {} });
    expect(answered.status).toBe(201);
    expect(opened[0]!.setup.direction).toBe("outbound");
    expect(opened[0]!.setup.greeting).toBe("Deploy failed. Roll back?");
    expect(hits[0]!.event.data).toMatchObject({ direction: "outbound", title: "Deploy", text: "Deploy failed. Roll back?" });
  });

  test("only listed accounts get live calls", async () => {
    app = createApp({ store, dataDir: mkdtempSync(join(tmpdir(), "herb-live-")), push, now: () => clock, voice: fakeVoice, liveAccounts: ["someone-else"] });
    expect((await callAgent()).status).toBe(503);
    expect((await req("/v1/call", botToken, { body: { live: true, text: "x" } })).status).toBe(503);
    const status = (await (await req("/v1/status", devToken)).json()) as { live: { available: boolean } };
    expect(status.live.available).toBe(false);
  });

  test("a one-way call cannot go live", async () => {
    const placed = (await (await req("/v1/call", botToken, { body: { text: "hi" } })).json()) as { id: string };
    expect((await req(`/v1/calls/${placed.id}/live`, devToken, { body: {} })).status).toBe(409);
  });
});

describe("during a call", () => {
  let callId: string;
  let call: Opened;

  beforeEach(async () => {
    await setWebhook();
    callId = (await callAgent()).body.call.id;
    call = opened[0]!;
    hits = [];
  });

  test("ask answered right away", async () => {
    hookReply = () => json({ answer: "212 rows, all fixable" });
    call.controls.transcript({ role: "user", text: "Can we fill them?" });
    expect(await call.controls.ask("How many rows?")).toEqual({ answer: "212 rows, all fixable" });
    expect(hits[0]!.event.data).toEqual({
      ask_id: "ask_1",
      question: "How many rows?",
      transcript: [{ role: "user", text: "Can we fill them?" }],
    });
  });

  test("ask answered later through the API", async () => {
    hookReply = () => json({ pending: true, note: "about a minute" });
    expect(await call.controls.ask("Run the migration?")).toEqual({ pending: true, ask_id: "ask_1", note: "about a minute" });
    const answer = (askId: string, token = botToken) =>
      req(`/v1/calls/${callId}/answers`, token, { body: { ask_id: askId, answer: "Migration passed" } });
    expect((await answer("ask_1", otherBotToken)).status).toBe(404);
    expect((await answer("ask_9")).status).toBe(404);
    expect((await answer("ask_1")).status).toBe(200);
    expect(call.log).toEqual(["answer:ask_1:Migration passed"]);
    expect((await answer("ask_1")).status).toBe(404);
  });

  test("another agent of the account replies over MCP without ids", async () => {
    const chief = store.addBot({ accountId, name: "Chief" }).token;
    const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
      const response = await req("/mcp", token, { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
      const body = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
      return { isError: body.result.isError, data: JSON.parse(body.result.content[0]!.text) };
    };

    call.controls.transcript({ role: "user", text: "How are my agents doing?" });
    expect((await call.controls.ask("How are my agents doing?")) as unknown).toMatchObject({ pending: true });
    const status = await tool(chief, "live_call_status");
    expect(status.data.live_call).toMatchObject({
      call_id: callId,
      agent: "Codex",
      open_questions: [{ ask_id: "ask_1", question: "How are my agents doing?" }],
    });

    expect((await tool(chief, "live_call_reply", { text: "All four agents are online." })).data).toEqual({ ok: true, call_id: callId, answered: "ask_1" });
    // No open question left: the reply is said to the user.
    expect((await tool(chief, "live_call_reply", { text: "Also, Grok finished its task." })).data).toEqual({ ok: true, call_id: callId, answered: null });
    expect((await tool(chief, "live_call_context", { text: "Grok ran for 3 minutes" })).isError).toBe(false);
    expect(call.log).toEqual([
      "answer:ask_1:All four agents are online.",
      "say:Also, Grok finished its task.:false",
      "context:Grok ran for 3 minutes",
    ]);

    // Agents of other accounts see no call.
    expect((await tool(otherBotToken, "live_call_status")).data).toEqual({ live_call: null });
    expect((await tool(otherBotToken, "live_call_reply", { text: "x" })).isError).toBe(true);
    expect((await req(`/v1/calls/${callId}/say`, otherBotToken, { body: { text: "x" } })).status).toBe(404);

    // The same over HTTP, then hang up.
    const current = (await (await req("/v1/live/current", chief)).json()) as { live_call: { call_id: string } };
    expect(current.live_call.call_id).toBe(callId);
    expect((await req("/v1/live/reply", chief, { body: { text: "Bye for now" } })).status).toBe(200);
    expect((await tool(chief, "live_call_hang_up")).isError).toBe(false);
    expect(store.call(callId)!.ended_reason).toBe("agent_hung_up");
    expect((await tool(chief, "live_call_reply", { text: "late" })).data.error.code).toBe("no_live_call");
  });

  test("ask with nobody reachable", async () => {
    hookReply = () => new Response("down", { status: 500 });
    expect(await call.controls.ask("Anyone?")).toEqual({ offline: true });
  });

  test("open asks are limited and expire", async () => {
    for (let i = 0; i < 3; i++) await call.controls.ask(`q${i}`);
    expect(await call.controls.ask("one more")).toEqual({ error: "too_many_asks" });
    clock += 5 * 60_000;
    app.tick();
    expect(call.log).toEqual(["expired:ask_1", "expired:ask_2", "expired:ask_3"]);
    expect((await call.controls.ask("again")) as unknown).toMatchObject({ pending: true });
  });

  test("handler says, adds context and hangs up", async () => {
    expect((await req(`/v1/calls/${callId}/say`, botToken, { body: { text: "Tests passed", interrupt: true } })).status).toBe(200);
    expect((await req(`/v1/calls/${callId}/context`, botToken, { body: { text: "PR #42 is open" } })).status).toBe(200);
    expect((await req(`/v1/calls/${callId}/say`, botToken, { body: {} })).status).toBe(400);
    expect((await req(`/v1/calls/${callId}/say`, otherBotToken, { body: { text: "x" } })).status).toBe(404);

    call.controls.transcript({ role: "agent", text: "Hi" });
    clock += 61_500;
    expect((await req(`/v1/calls/${callId}/hangup`, botToken, { body: {} })).status).toBe(200);
    expect(call.log).toEqual(["say:Tests passed:true", "context:PR #42 is open", "hangup:agent_hung_up"]);

    const stored = (await (await req(`/v1/calls/${callId}`, devToken)).json()) as Record<string, unknown>;
    expect(stored).toMatchObject({ status: "ended", live: true, ended_reason: "agent_hung_up", duration_s: 62 });
    await flush();
    const ended = hits.find((h) => h.event.type === "call.ended")!;
    expect(ended.event.data).toEqual({ reason: "agent_hung_up", duration_s: 62, transcript: [{ role: "agent", text: "Hi" }] });
    expect((await req(`/v1/calls/${callId}/say`, botToken, { body: { text: "late" } })).status).toBe(409);
  });

  test("phone hangs up", async () => {
    expect((await req(`/v1/calls/${callId}/end`, devToken, { body: {} })).status).toBe(200);
    expect(store.call(callId)!.ended_reason).toBe("user_hung_up");
    expect(call.log).toEqual(["hangup:user_hung_up"]);
    expect((await callAgent()).status).toBe(201);
  });

  test("call.ended is retried until delivered", async () => {
    let attempts = 0;
    hookReply = (hit) => (hit.event.type === "call.ended" && ++attempts === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 204 }));
    call.controls.end("user_hung_up");
    await flush();
    await flush();
    expect(attempts).toBe(2);
  });
});

describe("minutes", () => {
  beforeEach(() => makeApp({ billing: true }));

  test("no minutes, no live call", async () => {
    expect((await callAgent()).status).toBe(402);
    expect((await req("/v1/call", botToken, { body: { live: true, text: "x" } })).status).toBe(402);
    expect((await req("/v1/call", botToken, { body: { text: "one-way stays free" } })).status).toBe(202);
  });

  test("time is charged and the call ends when it runs out", async () => {
    store.addLiveSeconds(accountId, 120);
    const status = (await (await req("/v1/status", devToken)).json()) as { live: unknown };
    expect(status.live).toEqual({ available: true, billing: true, seconds_left: 120 });

    const first = (await callAgent()).body.call.id;
    clock += 30_000;
    expect((await req(`/v1/calls/${first}/end`, devToken, { body: {} })).status).toBe(200);
    expect(store.liveSeconds(accountId)).toBe(90);

    await callAgent();
    clock += 89_000;
    app.tick();
    expect(opened[1]!.log).toEqual([]);
    clock += 1_000;
    app.tick();
    expect(opened[1]!.log).toEqual(["hangup:no_minutes"]);
    expect(store.liveSeconds(accountId)).toBe(0);
    expect(store.listCalls(accountId, 1)[0]!.ended_reason).toBe("no_minutes");
  });
});

describe("event listener", () => {
  let server: ReturnType<typeof Bun.serve>;
  const sockets: WebSocket[] = [];

  beforeEach(() => {
    server = Bun.serve({
      port: 0,
      fetch: (request, srv) => {
        const upgraded = app.upgrade(request, srv);
        return upgraded === null ? app.handle(request) : upgraded;
      },
      websocket: app.websocket,
    });
  });

  afterEach(() => {
    for (const socket of sockets) socket.close();
    server.stop(true);
  });

  function connect(token: string) {
    const socket = new WebSocket(`ws://localhost:${server.port}/v1/events`, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
    sockets.push(socket);
    const messages: Record<string, unknown>[] = [];
    socket.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data))));
    const ready = new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("connect failed")));
    });
    return { socket, messages, ready };
  }

  async function until(check: () => boolean) {
    for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
    expect(check()).toBe(true);
  }

  test("rejects requests without an agent token", async () => {
    const response = await fetch(`http://localhost:${server.port}/v1/events`, { headers: { authorization: `Bearer ${devToken}` } });
    expect(response.status).toBe(401);
  });

  test("gets events, replies, and acts on calls; wins over the webhook", async () => {
    await setWebhook();
    const { socket, messages, ready } = connect(botToken);
    await ready;
    await until(() => app.live.listenerConnected(botId));

    const started = callAgent();
    await until(() => messages.length === 1);
    const event = messages[0] as { id: string; type: string; call_id: string };
    expect(event.type).toBe("call.started");
    socket.send(JSON.stringify({ reply_to: event.id, context: "From the listener" }));
    const { body } = await started;
    expect(opened[0]!.setup.context).toBe("From the listener");
    expect(hits).toHaveLength(0);

    const asked = opened[0]!.controls.ask("Status?");
    await until(() => messages.length === 2);
    const askEvent = messages[1] as { id: string; data: { ask_id: string } };
    socket.send(JSON.stringify({ reply_to: askEvent.id, pending: true }));
    expect(await asked).toMatchObject({ pending: true });
    socket.send(JSON.stringify({ type: "answer", call_id: body.call.id, ask_id: askEvent.data.ask_id, answer: "All green" }));
    socket.send(JSON.stringify({ type: "say", call_id: "nope", text: "x" }));
    await until(() => opened[0]!.log.length === 1 && messages.length === 3);
    expect(opened[0]!.log).toEqual(["answer:ask_1:All green"]);
    expect(messages[2]).toMatchObject({ type: "error", call_id: "nope", error: { code: "not_found" } });
  });

  test("a new listener replaces the old one", async () => {
    const first = connect(botToken);
    await first.ready;
    const closed = new Promise<number>((resolve) => first.socket.addEventListener("close", (e) => resolve(e.code)));
    const second = connect(botToken);
    await second.ready;
    expect(await closed).toBe(4000);
    expect(app.live.listenerConnected(botId)).toBe(true);
  });
});

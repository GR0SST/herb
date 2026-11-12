import { beforeEach, describe, expect, test } from "bun:test";
import { attach, buildInstructions, createGptLive, type Socket } from "../src/gptlive";
import type { AskResult, CallControls, CallSetup, EndReason, TranscriptLine } from "../src/live";
import type { Bot, Call } from "../src/db";

class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  closed = false;
  private listeners: Record<string, ((event: { data: unknown }) => void)[]> = {};
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners[type] ?? []) listener({ data: data === undefined ? undefined : JSON.stringify(data) });
  }
  types() {
    return this.sent.map((e) => e.type);
  }
}

const setup: CallSetup = { direction: "inbound", agent: "Codex", language: null, context: "Billing thread", instructions: "Be brief", greeting: null };
let socket: FakeSocket;
let lines: TranscriptLine[];
let ended: EndReason[];
let questions: string[];
let usages: number[];
let askResult: AskResult;

function controls(): CallControls {
  return {
    ask: async (question) => {
      questions.push(question);
      return askResult;
    },
    transcript: (line) => lines.push(line),
    end: (reason) => ended.push(reason),
    usage: (seconds) => usages.push(seconds),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

beforeEach(() => {
  socket = new FakeSocket();
  lines = [];
  ended = [];
  questions = [];
  usages = [];
  askResult = { answer: "212 rows" };
});

describe("session setup", () => {
  test("creates a client-delegation session and attaches the sideband", async () => {
    let request: { url: string; body: Record<string, any>; headers: Headers } | null = null;
    let attached: { url: string; headers: Record<string, string> } | null = null;
    const engine = createGptLive({
      apiKey: "sk-test",
      fetchImpl: (async (url: string, init: RequestInit) => {
        request = { url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) };
        return Response.json({ session: { id: "live_123" }, transport: { type: "webrtc", sdp: "answer-sdp" } }, { status: 201 });
      }) as unknown as typeof fetch,
      connect: (url, headers) => {
        attached = { url, headers };
        return socket;
      },
    });
    const opened = await engine.open({
      call: {} as Call,
      bot: { account_id: "acc-1" } as Bot,
      setup,
      controls: controls(),
      body: { sdp: "offer-sdp" },
    });
    expect(opened.client).toEqual({ session_id: "live_123", sdp: "answer-sdp" });
    expect(request!.url).toBe("https://api.openai.com/v1/live/sessions");
    expect(request!.headers.get("authorization")).toBe("Bearer sk-test");
    const session = request!.body.session;
    expect(session.model).toBe("gpt-live-1");
    expect(session.delegation).toEqual({ type: "client" });
    expect(session.instructions).toContain("Billing thread");
    expect(request!.headers.get("openai-safety-identifier")).toHaveLength(64);
    expect(JSON.stringify(request!.body)).not.toContain("acc-1");
    expect(session.client.data_channel.allowed_client_events).toEqual([]);
    expect(request!.body.transport).toEqual({ type: "webrtc", sdp: "offer-sdp" });
    expect(attached!.url).toBe("https://api.openai.com/v1/live/sessions/live_123/attach");
    expect(attached!.headers.authorization).toBe("Bearer sk-test");
  });

  test("fails without an offer or on an API error", async () => {
    const engine = createGptLive({
      apiKey: "sk",
      fetchImpl: (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch,
      connect: () => socket,
    });
    const input = { call: {} as Call, bot: { account_id: "a" } as Bot, setup, controls: controls() };
    expect(engine.open({ ...input, body: {} })).rejects.toThrow("SDP");
    expect(engine.open({ ...input, body: { sdp: "x" } })).rejects.toThrow("400");
  });

  test("instructions carry the context, direction, agent and language", () => {
    expect(buildInstructions({ ...setup, direction: "outbound" })).toContain("The main agent called the user");
    expect(buildInstructions({ ...setup, context: "" })).not.toContain("before the call");
    expect(buildInstructions(setup)).toContain("You always speak first");
    expect(buildInstructions(setup)).toContain("called Codex");
    expect(buildInstructions({ ...setup, language: "uk" })).toContain("code uk");
    expect(buildInstructions(setup)).toContain("speak the language they are written in");
  });
});

describe("sideband", () => {
  function started(greeting: string | null = null) {
    const session = attach(socket, { ...setup, greeting }, controls());
    socket.emit("open");
    socket.emit("message", { type: "session.started", event_id: "e0" });
    return session;
  }

  test("commands wait for session.started; greeting goes first", () => {
    const session = attach(socket, { ...setup, greeting: "Hi, billing thread" }, controls());
    session.addContext("PR #42 is open");
    socket.emit("open");
    expect(socket.sent).toEqual([]);
    socket.emit("message", { type: "session.started", event_id: "e0" });
    expect(socket.sent).toMatchObject([
      { type: "session.thinking.append", delegation_id: null, content: "PR #42 is open" },
      { type: "session.instructions.append", delegation_id: null },
    ]);
    expect(String(socket.sent[1]!.content)).toContain("Hi, billing thread");
  });

  test("transcript lines are grouped by speaker; replays are ignored", () => {
    started();
    socket.emit("message", { type: "session.output_transcript.delta", event_id: "e1", delta: "Hi, " });
    socket.emit("message", { type: "session.output_transcript.delta", event_id: "e2", delta: "how can I help?" });
    socket.emit("message", { type: "session.output_transcript.delta", event_id: "e2", delta: "how can I help?" });
    socket.emit("message", { type: "session.input_transcript.delta", event_id: "e3", delta: "Fill the rows" });
    socket.emit("message", { type: "session.output_transcript.delta", event_id: "e4", delta: "Sure" });
    expect(lines).toEqual([
      { role: "agent", text: "Hi, how can I help?" },
      { role: "user", text: "Fill the rows" },
    ]);
  });

  test("a delegation asks the main agent with what the user said", async () => {
    started();
    socket.emit("message", { type: "session.input_transcript.delta", event_id: "e1", delta: "How many rows are broken?" });
    socket.emit("message", { type: "session.delegation.created", event_id: "e2", delegation: { id: "del_1", target: "client" } });
    await tick();
    expect(questions).toEqual(["How many rows are broken?"]);
    expect(socket.sent.at(-1)).toMatchObject({ type: "session.commentary.append", delegation_id: "del_1" });
    expect(String(socket.sent.at(-1)!.content)).toContain("212 rows");

    socket.emit("message", { type: "session.delegation.created", event_id: "e3", delegation: { id: "del_2" } });
    await tick();
    expect(questions[1]).toContain("last thing they said");
  });

  test("a later answer goes to the right delegation", async () => {
    const session = started();
    askResult = { pending: true, ask_id: "ask_1", note: null };
    socket.emit("message", { type: "session.delegation.created", event_id: "e1", delegation: { id: "del_7" } });
    await tick();
    session.answer("ask_1", "Migration passed");
    expect(socket.sent.at(-1)).toMatchObject({ type: "session.commentary.append", delegation_id: "del_7" });
    expect(String(socket.sent.at(-1)!.content)).toContain("Migration passed");
  });

  test("long text is split into appends", () => {
    const session = started();
    socket.sent = [];
    session.say("x".repeat(3200), false);
    expect(socket.types()).toEqual(["session.commentary.append", "session.commentary.append", "session.commentary.append"]);
  });

  test("the voice agent always opens the call", () => {
    started();
    expect(socket.sent[0]).toMatchObject({ type: "session.instructions.append" });
    expect(String(socket.sent[0]!.content)).toContain("greet the user in one short sentence as Codex");
  });

  test("the voice agent hangs up after its goodbye, once it is quiet", async () => {
    started();
    const decided = (probability: number, id: string) =>
      socket.emit("message", { type: "decision.event", event_id: id, event: { type: "decision.completed", decision: { answers: [{ type: "predicate", name: "call_finished", probability }] } } });
    socket.emit("message", { type: "session.output_transcript.delta", event_id: "e1", delta: "Hi, quick question?" });
    // A goodbye before the user spoke does not end the call.
    decided(0.95, "d1");
    socket.emit("message", { type: "session.input_transcript.delta", event_id: "e2", delta: "Tuesday works." });
    decided(0.3, "d2");
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(ended).toEqual([]);
    socket.emit("message", { type: "session.output_transcript.delta", event_id: "e3", delta: "Thanks, bye!" });
    decided(0.92, "d3");
    expect(ended).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect(ended).toEqual(["agent_hung_up"]);
    expect(socket.types()).toContain("session.close");
    socket.emit("message", { type: "session.closed", event_id: "e4", reason: "close_requested", usage: { seconds: 31.4 } });
    expect(ended).toEqual(["agent_hung_up"]);
    expect(usages).toEqual([31.4]);
  }, 10_000);

  test("sessions watch for the end of the call", async () => {
    let body: Record<string, any> | null = null;
    const engine = createGptLive({
      apiKey: "sk",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return Response.json({ session: { id: "live_1" }, transport: { sdp: "a" } }, { status: 201 });
      }) as unknown as typeof fetch,
      connect: () => socket,
    });
    await engine.open({ call: {} as Call, bot: { account_id: "a" } as Bot, setup, controls: controls(), body: { sdp: "o" } });
    expect(body!.session.triggers[0]).toMatchObject({ type: "decisions", event_type: "session.output_transcript.delta" });
    expect(body!.session.triggers[0].decisions.questions[0]).toMatchObject({ type: "predicate", name: "call_finished" });
  });

  test("the user hanging up ends the call once", () => {
    started();
    socket.emit("message", { type: "session.input_transcript.delta", event_id: "e1", delta: "Bye" });
    socket.emit("message", { type: "session.closed", event_id: "e2", reason: "remote_hangup" });
    socket.emit("close");
    expect(ended).toEqual(["user_hung_up"]);
    expect(lines).toEqual([{ role: "user", text: "Bye" }]);
    expect(socket.closed).toBe(true);
  });

  test("a lost connection fails the call", () => {
    started();
    socket.emit("close");
    expect(ended).toEqual(["failed"]);
  });

  test("hanging up from our side closes the session without reporting twice", () => {
    const session = started();
    socket.emit("message", { type: "session.output_transcript.delta", event_id: "e0b", delta: "Two tests fail." });
    session.hangup("user_hung_up");
    expect(lines).toEqual([{ role: "agent", text: "Two tests fail." }]);
    expect(socket.types()).toContain("session.close");
    socket.emit("message", { type: "session.closed", event_id: "e1", reason: "close_requested" });
    expect(ended).toEqual([]);
  });
});

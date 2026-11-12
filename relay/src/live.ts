import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Bot, Call, Store } from "./db";

export type Direction = "inbound" | "outbound";
export type EndReason = "user_hung_up" | "agent_hung_up" | "no_minutes" | "failed";
export interface TranscriptLine {
  role: "user" | "agent";
  text: string;
}

/** The voice side of a call: the speech model that talks to the phone. */
export interface VoiceSession {
  say(text: string, interrupt: boolean): void;
  addContext(text: string): void;
  answer(askId: string, answer: string): void;
  askExpired(askId: string): void;
  hangup(reason: EndReason): void;
}

/** What the voice side may do during a call. */
export interface CallControls {
  ask(question: string): Promise<AskResult>;
  transcript(line: TranscriptLine): void;
  end(reason: EndReason): void;
}

/** Connects a phone to a speech model. GPT-Live in production, a fake in tests. */
export interface VoiceEngine {
  open(input: { call: Call; bot: Bot; setup: CallSetup; controls: CallControls; body: Record<string, unknown> }): Promise<{
    client: unknown;
    session: VoiceSession;
  }>;
}

export interface CallSetup {
  direction: Direction;
  context: string;
  instructions: string;
  /** First line of the voice agent. For an outbound call it is the agent's message. */
  greeting: string | null;
}

export type AskResult =
  | { answer: string }
  | { pending: true; ask_id: string; note: string | null }
  | { offline: true }
  | { error: string };

export const LIVE_LIMITS = {
  context: 16_000,
  instructions: 4_000,
  greeting: 300,
  answer: 8_000,
  say: 2_000,
  question: 2_000,
  note: 300,
  openAsks: 3,
  message: 64 * 1024,
};
export const LIVE_TIMEOUTS = { started: 3_000, ask: 5_000, askExpiry: 5 * 60_000, ended: 10_000 };
const RETRY_DELAYS = [10_000, 60_000, 600_000, 3_600_000];
const ASK_TRANSCRIPT_LINES = 20;
const MAX_TRANSCRIPT_LINES = 2_000;
const ACTIONS = ["answer", "say", "context", "hangup"] as const;
export type LiveAction = (typeof ACTIONS)[number];

/** A WebSocket as the hub needs it. */
export interface Listener {
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

interface LiveCall {
  call: Call;
  bot: Bot;
  direction: Direction;
  startedAt: number;
  /** Seconds the account can spend, or null without billing. */
  budget: number | null;
  voice: VoiceSession | null;
  /** Actions that arrived before the voice side was connected. */
  queued: ((voice: VoiceSession) => void)[];
  transcript: TranscriptLine[];
  asks: Map<string, number>;
  askCount: number;
}

interface Event {
  id: string;
  type: "call.started" | "agent.ask" | "call.ended";
  call_id: string;
  agent_id: string;
  created_at: number;
  data: Record<string, unknown>;
}

type Reply = Record<string, unknown>;
/** reached: someone got the event. reply: what they answered in time, if anything. */
type Delivery = { reached: boolean; reply: Reply | null };

export interface LiveOptions {
  store: Store;
  now: () => number;
  fetchImpl: typeof fetch;
  /** Charge live calls against the account's minutes. Off on self-hosted servers. */
  billing: boolean;
  /** Allow webhooks to private addresses and plain http. Only for self-hosted servers. */
  allowPrivateWebhooks: boolean;
  resolveHost?: (host: string) => Promise<string[]>;
  retryDelays?: number[];
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;

export function signWebhook(secret: string, timestamp: number, body: string) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Standard Webhooks signature (https://www.standardwebhooks.com), which many services verify. */
export function signStandardWebhook(secret: string, id: string, timestamp: number, body: string) {
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret);
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function privateIPv4(ip: string) {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || b === 0))
    || (a === 198 && (b === 18 || b === 19));
}

export function isPrivateAddress(ip: string) {
  if (isIP(ip) === 4) return privateIPv4(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateIPv4(mapped[1]!);
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff") || v6.startsWith("::ffff:");
}

/** Checks the form of a webhook address. Returns an error message or null. */
export function webhookUrlError(raw: string, allowPrivate: boolean) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Not a valid URL";
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) return "Webhook URL must start with https://";
  if (url.username || url.password) return "Webhook URL must not contain a user or password";
  if (raw.length > 500) return "Webhook URL is too long";
  return null;
}

export function createLive(options: LiveOptions) {
  const { store, now, fetchImpl, billing } = options;
  const resolveHost = options.resolveHost ?? (async (host: string) => (await lookup(host, { all: true })).map((a) => a.address));
  const retryDelays = options.retryDelays ?? RETRY_DELAYS;
  const calls = new Map<string, LiveCall>();
  const listeners = new Map<string, Listener>();
  const waiting = new Map<string, { botId: string; resolve: (reply: Reply | null) => void }>();

  // Delivery

  /** Webhooks must not reach the server's own network. Checked on every send, since DNS can change. */
  async function safeWebhook(raw: string) {
    if (webhookUrlError(raw, options.allowPrivateWebhooks)) return false;
    if (options.allowPrivateWebhooks) return true;
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
    try {
      const addresses = isIP(host) ? [host] : await resolveHost(host);
      return addresses.length > 0 && !addresses.some(isPrivateAddress);
    } catch {
      return false;
    }
  }

  function viaListener(listener: Listener, botId: string, event: Event, timeoutMs: number) {
    return new Promise<Delivery>((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(event.id);
        resolve({ reached: true, reply: null });
      }, timeoutMs);
      waiting.set(event.id, {
        botId,
        resolve: (reply) => {
          clearTimeout(timer);
          waiting.delete(event.id);
          resolve({ reached: true, reply });
        },
      });
      try {
        listener.send(JSON.stringify(event));
      } catch {
        clearTimeout(timer);
        waiting.delete(event.id);
        resolve({ reached: false, reply: null });
      }
    });
  }

  async function viaWebhook(bot: Bot, event: Event, timeoutMs: number): Promise<Delivery> {
    if (!bot.webhook_url || !bot.webhook_secret || !(await safeWebhook(bot.webhook_url))) return { reached: false, reply: null };
    const body = JSON.stringify(event);
    const timestamp = Math.floor(now() / 1000);
    try {
      const response = await fetchImpl(bot.webhook_url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          "user-agent": "Herb-Webhook/1",
          "herb-event-id": event.id,
          "herb-timestamp": String(timestamp),
          "herb-signature": signWebhook(bot.webhook_secret, timestamp, body),
          "webhook-id": event.id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signStandardWebhook(bot.webhook_secret, event.id, timestamp, body),
        },
        body,
      });
      if (response.status < 200 || response.status >= 300) return { reached: false, reply: null };
      if (response.status !== 200) return { reached: true, reply: null };
      const raw = (await response.text()).slice(0, LIVE_LIMITS.message);
      try {
        const parsed = JSON.parse(raw) as unknown;
        return { reached: true, reply: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Reply) : null };
      } catch {
        return { reached: true, reply: null };
      }
    } catch {
      return { reached: false, reply: null };
    }
  }

  /** A connected listener wins over the webhook. */
  function deliver(bot: Bot, event: Event, timeoutMs: number): Promise<Delivery> {
    const listener = listeners.get(bot.id);
    if (listener) return viaListener(listener, bot.id, event, timeoutMs);
    return viaWebhook(bot, event, timeoutMs);
  }

  function event(live: LiveCall, type: Event["type"], data: Record<string, unknown>): Event {
    return { id: newId("evt"), type, call_id: live.call.id, agent_id: live.bot.id, created_at: now(), data };
  }

  /** The only event worth retrying: the moment of the others is gone by then. */
  function deliverEnded(bot: Bot, ended: Event, attempt = 0) {
    void deliver(bot, ended, LIVE_TIMEOUTS.ended).then(({ reached }) => {
      const delay = retryDelays[attempt];
      if (reached || delay === undefined || listeners.has(bot.id) || !bot.webhook_url) return;
      const timer = setTimeout(() => {
        // The agent may have been deleted or its webhook changed in the meantime.
        const fresh = store.bot(bot.id);
        if (fresh?.webhook_url === bot.webhook_url) deliverEnded(fresh, ended, attempt + 1);
      }, delay);
      (timer as { unref?: () => void }).unref?.();
    });
  }

  // Calls

  function activeCallFor(accountId: string) {
    for (const live of calls.values()) if (live.bot.account_id === accountId) return live.call;
    return null;
  }

  /** Whether the account may start a live call. Returns an error code or null. */
  function canStart(accountId: string) {
    if (billing && store.liveSeconds(accountId) <= 0) return "no_minutes";
    if (activeCallFor(accountId)) return "call_in_progress";
    return null;
  }

  /** Registers an answered call and asks the handler for context. */
  async function start(call: Call, bot: Bot, direction: Direction): Promise<CallSetup> {
    const live: LiveCall = {
      call,
      bot,
      direction,
      startedAt: now(),
      budget: billing ? store.liveSeconds(bot.account_id) : null,
      voice: null,
      queued: [],
      transcript: [],
      asks: new Map(),
      askCount: 0,
    };
    calls.set(call.id, live);
    const data: Record<string, unknown> = { direction };
    if (direction === "outbound") Object.assign(data, { title: call.title, text: call.text, language: call.language });
    const { reply } = await deliver(bot, event(live, "call.started", data), LIVE_TIMEOUTS.started);
    const extra = text(reply?.instructions, LIVE_LIMITS.instructions);
    return {
      direction,
      context: text(reply?.context, LIVE_LIMITS.context),
      instructions: [bot.live_instructions ?? "", extra].filter(Boolean).join("\n\n"),
      greeting: direction === "outbound" ? call.text : text(reply?.greeting, LIVE_LIMITS.greeting) || null,
    };
  }

  function attachVoice(callId: string, voice: VoiceSession) {
    const live = calls.get(callId);
    if (!live) return;
    live.voice = voice;
    for (const action of live.queued.splice(0)) action(voice);
  }

  function withVoice(live: LiveCall, action: (voice: VoiceSession) => void) {
    if (live.voice) action(live.voice);
    else live.queued.push(action);
  }

  function transcript(callId: string, line: TranscriptLine) {
    const live = calls.get(callId);
    if (!live || !line.text.trim()) return;
    live.transcript.push({ role: line.role, text: line.text.trim() });
    if (live.transcript.length > MAX_TRANSCRIPT_LINES) live.transcript.shift();
  }

  async function ask(callId: string, rawQuestion: string): Promise<AskResult> {
    const live = calls.get(callId);
    if (!live) return { error: "call_ended" };
    const question = text(rawQuestion, LIVE_LIMITS.question);
    if (!question) return { error: "empty_question" };
    if (live.asks.size >= LIVE_LIMITS.openAsks) return { error: "too_many_asks" };
    const askId = `ask_${++live.askCount}`;
    live.asks.set(askId, now());
    const { reached, reply } = await deliver(live.bot, event(live, "agent.ask", {
      ask_id: askId,
      question,
      transcript: live.transcript.slice(-ASK_TRANSCRIPT_LINES),
    }), LIVE_TIMEOUTS.ask);
    if (!reached) {
      live.asks.delete(askId);
      return { offline: true };
    }
    const answer = text(reply?.answer, LIVE_LIMITS.answer);
    // The ask may have been answered through the API while the webhook was still running.
    if (!live.asks.has(askId)) return answer ? { answer } : { pending: true, ask_id: askId, note: null };
    if (answer) {
      live.asks.delete(askId);
      return { answer };
    }
    // No answer in time: the handler can still answer later.
    return { pending: true, ask_id: askId, note: text(reply?.note, LIVE_LIMITS.note) || null };
  }

  function end(callId: string, reason: EndReason) {
    const live = calls.get(callId);
    if (!live) return;
    calls.delete(callId);
    const duration = Math.max(0, Math.ceil((now() - live.startedAt) / 1000));
    if (billing) store.addLiveSeconds(live.bot.account_id, -duration);
    store.endLiveCall(callId, reason, duration, now());
    deliverEnded(live.bot, event(live, "call.ended", { reason, duration_s: duration, transcript: live.transcript }));
  }

  /** Ends a call from our side: the voice agent is told to stop. */
  function hangup(callId: string, reason: EndReason) {
    const live = calls.get(callId);
    if (!live) return;
    withVoice(live, (voice) => voice.hangup(reason));
    end(callId, reason);
  }

  function controls(callId: string): CallControls {
    return {
      ask: (question) => ask(callId, question),
      transcript: (line) => transcript(callId, line),
      end: (reason) => end(callId, reason),
    };
  }

  /** Ends calls that ran out of minutes and drops asks nobody answered. Run every few seconds. */
  function tick() {
    for (const [id, live] of [...calls]) {
      if (live.budget !== null && now() - live.startedAt >= live.budget * 1000) {
        hangup(id, "no_minutes");
        continue;
      }
      for (const [askId, at] of live.asks) {
        if (now() - at < LIVE_TIMEOUTS.askExpiry) continue;
        live.asks.delete(askId);
        withVoice(live, (voice) => voice.askExpired(askId));
      }
    }
  }

  // Handler actions, over HTTP or the listener

  function act(bot: Bot, callId: string, action: LiveAction, body: Record<string, unknown>): { status: number; body: unknown } {
    const fail = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
    const live = calls.get(callId);
    if (!live || live.bot.id !== bot.id) {
      const stored = store.call(callId);
      if (stored && stored.bot_id === bot.id) return fail(409, "call_ended", "The call is not live");
      return fail(404, "not_found", "Call not found");
    }
    if (action === "hangup") {
      hangup(callId, "agent_hung_up");
      return { status: 200, body: { ok: true } };
    }
    if (action === "answer") {
      const askId = typeof body.ask_id === "string" ? body.ask_id : "";
      const answer = text(body.answer, LIVE_LIMITS.answer);
      if (!answer) return fail(400, "invalid_answer", "Answer is empty");
      if (!live.asks.delete(askId)) return fail(404, "ask_not_found", "No open question with this ask_id");
      withVoice(live, (voice) => voice.answer(askId, answer));
      return { status: 200, body: { ok: true } };
    }
    const value = text(body.text, action === "say" ? LIVE_LIMITS.say : LIVE_LIMITS.context);
    if (!value) return fail(400, "invalid_text", "Text is empty");
    if (action === "say") withVoice(live, (voice) => voice.say(value, body.interrupt === true));
    else withVoice(live, (voice) => voice.addContext(value));
    return { status: 200, body: { ok: true } };
  }

  // Listeners

  function attachListener(botId: string, listener: Listener) {
    const previous = listeners.get(botId);
    listeners.set(botId, listener);
    previous?.close(4000, "Replaced by a new listener");
  }

  function detachListener(botId: string, listener: Listener) {
    if (listeners.get(botId) === listener) listeners.delete(botId);
  }

  function listenerMessage(bot: Bot, listener: Listener, raw: string) {
    const reply = (data: Record<string, unknown>) => listener.send(JSON.stringify(data));
    if (raw.length > LIVE_LIMITS.message) return reply({ type: "error", code: "too_large", message: "Message is too large" });
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
    } catch {
      return reply({ type: "error", code: "invalid_json", message: "Invalid JSON" });
    }
    if (typeof message.reply_to === "string") {
      const pending = waiting.get(message.reply_to);
      if (pending?.botId === bot.id) {
        const { reply_to: _, ...rest } = message;
        pending.resolve(rest);
      }
      return;
    }
    const type = message.type as LiveAction;
    if (!ACTIONS.includes(type)) return reply({ type: "error", code: "unknown_type", message: "Unknown message type" });
    const callId = typeof message.call_id === "string" ? message.call_id : "";
    const result = act(bot, callId, type, message);
    if (result.status !== 200) reply({ type: "error", call_id: callId, ...(result.body as Record<string, unknown>) });
  }

  return {
    canStart,
    activeCallFor,
    start,
    attachVoice,
    controls,
    end,
    hangup,
    tick,
    act,
    attachListener,
    detachListener,
    listenerMessage,
    listenerConnected: (botId: string) => listeners.has(botId),
    safeWebhook,
  };
}

export type Live = ReturnType<typeof createLive>;

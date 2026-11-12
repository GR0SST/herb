import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PushSender } from "./apns";
import { clearSessionCookie, readCookie, SESSION_COOKIE, sessionCookie } from "./cookies";
import { type Bot, type Call, type CallStatus, type Device, type Store, TEST_AGENT_NAME } from "./db";
import { clientIp, WindowLimiter } from "./limits";
import { createLive, LIVE_LIMITS, type Direction, type LiveAction, type Listener, type VoiceEngine, webhookUrlError } from "./live";
import { handleMcp, type McpActions } from "./mcp";
import type { OAuth } from "./oauth";
import { notFoundPage, serveSite } from "./site";
import { normalizeLanguage } from "./speech";

export const MAX_TEXT = 2000;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
export const CALLS_PER_MINUTE = 6;
export const CALLS_PER_DAY = 200;
export const AUDIO_BYTES_PER_DAY = 200 * 1024 * 1024;
export const BOTS_PER_ACCOUNT = 50;
export const DEVICES_PER_ACCOUNT = 10;
export const NEW_ACCOUNTS_PER_IP_HOUR = 20;
export const NEW_ACCOUNTS_PER_HOUR = 500;
export const KEY_FAILURES_PER_IP = 10;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_CHAT_MESSAGES = 100;
const MAX_CHAT_CHARS = 200_000;
const MAX_NAME = 40;
const AUDIO_MIMES = new Set(["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/x-wav"]);
const DEVICE_STATUSES: readonly CallStatus[] = ["answered", "played", "declined", "missed", "failed"];
const LIVE_ACTIONS = new Set(["answer", "say", "context", "hangup"]);

export interface AppOptions {
  store: Store;
  dataDir: string;
  push: PushSender | null;
  oauth?: OAuth | null;
  /** Public address with no trailing slash. Used by the website and agent sign-in. */
  publicUrl?: string;
  openRegistration?: boolean;
  env?: Record<string, string | undefined>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Speech model for live calls. Without it live calls are off. */
  voice?: VoiceEngine | null;
  /** Charge live calls against bought minutes. */
  billing?: boolean;
  /** Let webhooks reach private addresses. Only for self-hosted servers. */
  allowPrivateWebhooks?: boolean;
  resolveHost?: (host: string) => Promise<string[]>;
  webhookRetryDelays?: number[];
}

/** Data attached to an agent's event listener connection. */
export interface ListenerData {
  botId: string;
}

/** The parts of Bun's server and socket the app needs, so tests can fake them. */
interface Upgrader {
  upgrade(request: Request, options: { data: ListenerData }): boolean;
}
interface ListenerSocket extends Listener {
  data: ListenerData;
}

/** Who is calling: a phone by token or a browser by session. */
interface Principal {
  accountId: string;
  device: Device | null;
}

const err = (status: number, code: string, message: string, headers?: Record<string, string>) =>
  Response.json({ error: { code, message } }, { status, headers });

function bearer(request: Request) {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

const publicCall = (call: Call) => ({
  id: call.id,
  bot_id: call.bot_id,
  bot_name: call.bot_name,
  title: call.title,
  text: call.text,
  language: call.language,
  has_audio: call.audio_mime !== null,
  status: call.status,
  live: call.live === 1,
  ...(call.live ? { ended_reason: call.ended_reason, duration_s: call.duration_s } : {}),
  created_at: call.created_at,
  updated_at: call.updated_at,
});

const publicBot = (bot: Bot) => ({
  id: bot.id,
  name: bot.name,
  capabilities: { chat: Boolean(bot.chat_url), calls: true },
});

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export function createAccounts(store: Store, options: { open: boolean; now: () => number }) {
  const perIp = new WindowLimiter(NEW_ACCOUNTS_PER_IP_HOUR, HOUR_MS);
  const global = new WindowLimiter(NEW_ACCOUNTS_PER_HOUR, HOUR_MS, 1);
  const keyFailures = new WindowLimiter(KEY_FAILURES_PER_IP, 15 * 60 * 1000);

  return {
    /** Returns the new account's key or a clear error. */
    create(request: Request): { id: string; key: string } | { error: Response } {
      if (!options.open) return { error: err(403, "registration_closed", "Registration is closed on this server") };
      const ip = clientIp(request);
      const now = options.now();
      if (perIp.exceeded(ip, now) || global.exceeded("all", now)) {
        return { error: err(429, "rate_limited", "Too many new accounts. Try again later") };
      }
      perIp.record(ip, now);
      global.record("all", now);
      return store.createAccount(now);
    },
    /** Checks a key, limiting attempts per address. */
    verifyKey(request: Request, key: string): { id: string } | { error: Response } {
      const ip = clientIp(request);
      const now = options.now();
      if (keyFailures.exceeded(ip, now)) return { error: err(429, "rate_limited", "Too many attempts. Wait 15 minutes") };
      const id = store.accountIdByKey(key);
      if (!id) {
        keyFailures.record(ip, now);
        return { error: err(401, "invalid_key", "Wrong account key") };
      }
      return { id };
    },
  };
}

export type Accounts = ReturnType<typeof createAccounts>;

export function createApp(options: AppOptions) {
  const { store, dataDir, push } = options;
  const oauth = options.oauth ?? null;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const accounts = createAccounts(store, { open: options.openRegistration ?? true, now });
  oauth?.useAccounts(accounts);
  const voice = options.voice ?? null;
  const allowPrivateWebhooks = options.allowPrivateWebhooks ?? false;
  const live = createLive({
    store,
    now,
    fetchImpl,
    billing: options.billing ?? false,
    allowPrivateWebhooks,
    resolveHost: options.resolveHost,
    retryDelays: options.webhookRetryDelays,
  });
  const origin = options.publicUrl ? new URL(options.publicUrl).origin : null;
  const audioDir = join(dataDir, "audio");
  mkdirSync(audioDir, { recursive: true });
  const audioPath = (id: string) => join(audioDir, id);
  const removeAudio = (ids: string[]) => ids.forEach((id) => rmSync(audioPath(id), { force: true }));
  const botFor = (token: string) => store.botByToken(token) ?? oauth?.botByAccessToken(token) ?? null;

  /** Rings every phone on the account. */
  async function ring(bot: Bot, call: Call) {
    const phones = store.listDevices(bot.account_id).filter((d) => d.voip_token);
    if (!push) return "disabled";
    if (phones.length === 0) return "no_device";
    const results = await Promise.all(phones.map(async (device) => {
      const result = await push.send(device, call);
      if (result.invalidToken && device.voip_token) store.clearVoipToken(device.voip_token);
      if (!result.ok) console.error(`push failed status=${result.status} reason=${result.reason ?? "?"}`);
      return result.ok;
    }));
    return results.some(Boolean) ? "sent" : "failed";
  }

  async function placeCall(bot: Bot, args: Record<string, unknown>) {
    const text = typeof args.text === "string" ? args.text.trim().normalize("NFC") : "";
    const audioB64 = typeof args.audio_base64 === "string" ? args.audio_base64 : "";
    const title = typeof args.title === "string" ? args.title.trim().slice(0, 120) : "";
    const key = typeof args.idempotency_key === "string" && args.idempotency_key ? args.idempotency_key.slice(0, 200) : undefined;
    const reject = (code: string, message: string, status = 400) => ({ status, body: { error: { code, message } } });
    const isLive = args.live === true;
    if (isLive) {
      if (!voice) return reject("live_unavailable", "Live calls are not available on this server", 503);
      if (audioB64) return reject("invalid_content", "A live call takes text, not audio");
      const blocked = live.canStart(bot.account_id);
      if (blocked === "no_minutes") return reject("no_minutes", "No live call minutes left", 402);
    }

    // Text and audio are optional: a call without a message just rings.
    if (text && audioB64) return reject("invalid_content", "Send either text or audio_base64, not both");
    if (text.length > MAX_TEXT) return reject("text_too_long", `Text is longer than ${MAX_TEXT} characters`);

    let audio: Buffer | undefined;
    let audioMime: string | undefined;
    if (audioB64) {
      audioMime = typeof args.audio_mime === "string" ? args.audio_mime : "";
      if (!AUDIO_MIMES.has(audioMime)) return reject("invalid_audio_mime", "Supported audio: mp3, m4a, aac, wav");
      audio = Buffer.from(audioB64, "base64");
      if (audio.length === 0) return reject("invalid_audio", "Audio is empty");
      if (audio.length > MAX_AUDIO_BYTES) return reject("audio_too_large", "Audio is larger than 10 MB");
    }

    if (key) {
      const existing = store.callByIdempotencyKey(bot.id, key);
      if (existing) return { status: 200, body: { ...publicCall(existing), deduplicated: true } };
    }
    if (store.recentCallCount(bot.id, now() - 60_000) >= CALLS_PER_MINUTE) {
      return reject("rate_limited", `No more than ${CALLS_PER_MINUTE} calls per minute`, 429);
    }
    const usage = store.accountUsage(bot.account_id, now() - DAY_MS);
    if (usage.calls >= CALLS_PER_DAY) return reject("daily_limit", `No more than ${CALLS_PER_DAY} calls per day`, 429);
    if (audio && (usage.bytes ?? 0) + audio.length > AUDIO_BYTES_PER_DAY) {
      return reject("daily_limit", "Daily audio limit reached", 429);
    }

    const call = store.createCall({
      botId: bot.id,
      title: title || undefined,
      text: text || undefined,
      language: text ? normalizeLanguage(args.language) : undefined,
      audioMime,
      audioBytes: audio?.length,
      idempotencyKey: key,
      live: isLive,
      now: now(),
    });
    if (audio) await Bun.write(audioPath(call.id), audio);
    return { status: 202, body: { ...publicCall(call), push: await ring(bot, call) } };
  }

  function callStatusForBot(bot: Bot, id: string) {
    store.expireRinging(now());
    const call = store.call(id);
    if (!call || call.bot_id !== bot.id) return { status: 404, body: { error: { code: "not_found", message: "Call not found" } } };
    return { status: 200, body: publicCall(call) };
  }

  const mcpActions: McpActions = { placeCall, callStatus: callStatusForBot };

  async function chat(bot: Bot, request: Request) {
    if (!bot.chat_url) return err(409, "chat_unavailable", "This agent has no chat");
    const body = await readJson<{ messages?: unknown }>(request);
    if (!body) return err(400, "invalid_json", "Invalid JSON");
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_CHAT_MESSAGES) {
      return err(400, "invalid_messages", "Messages must be a non-empty list");
    }
    let total = 0;
    const clean: { role: string; content: string }[] = [];
    for (const m of messages as { role?: unknown; content?: unknown }[]) {
      if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
        return err(400, "invalid_messages", "Only user and assistant messages are allowed");
      }
      total += m.content.length;
      clean.push({ role: m.role, content: m.content });
    }
    if (total > MAX_CHAT_CHARS) return err(413, "too_long", "Chat history is too long");

    const key = bot.chat_key_env ? env[bot.chat_key_env] : undefined;
    if (bot.chat_key_env && !key) return err(503, "chat_not_configured", "Chat is not configured on the server");

    const url = `${bot.chat_url.replace(/\/+$/, "")}/chat/completions`;
    let upstream: Response;
    try {
      upstream = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: bot.chat_model ?? "default", messages: clean, stream: true }),
        signal: request.signal,
      });
    } catch (error) {
      console.error(`chat upstream unreachable bot=${bot.id}: ${(error as Error).message}`);
      return err(502, "chat_unreachable", `${bot.name} is unavailable`);
    }
    if (!upstream.ok || !upstream.body) {
      console.error(`chat upstream status=${upstream.status} bot=${bot.id}`);
      return err(502, "chat_upstream_error", `${bot.name} returned error ${upstream.status}`);
    }
    return new Response(upstream.body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  }

  /** Connects an answered live call to the speech model. */
  async function connectLive(call: Call, bot: Bot, direction: Direction, request: Request) {
    const body = (await readJson<Record<string, unknown>>(request)) ?? {};
    const setup = await live.start(call, bot, direction);
    try {
      const opened = await voice!.open({ call, bot, setup, controls: live.controls(call.id), body });
      live.attachVoice(call.id, opened.session);
      return Response.json({ call: publicCall(store.call(call.id)!), voice: opened.client }, { status: 201 });
    } catch (error) {
      console.error(`voice failed call=${call.id}: ${(error as Error).message}`);
      live.end(call.id, "failed");
      return err(502, "voice_unavailable", "Could not connect the voice agent");
    }
  }

  function liveBlocked(accountId: string) {
    if (!voice) return err(503, "live_unavailable", "Live calls are not available on this server");
    const blocked = live.canStart(accountId);
    if (blocked === "no_minutes") return err(402, "no_minutes", "No live call minutes left");
    if (blocked === "call_in_progress") return err(409, "call_in_progress", "Another live call is in progress");
    return null;
  }

  /** The phone calls an agent. */
  async function startInbound(accountId: string, request: Request) {
    const body = await readJson<{ bot_id?: unknown }>(request.clone());
    if (!body) return err(400, "invalid_json", "Invalid JSON");
    const bot = typeof body.bot_id === "string" ? store.bot(body.bot_id) : null;
    if (!bot || bot.account_id !== accountId || bot.name === TEST_AGENT_NAME) return err(404, "not_found", "Agent not found");
    const blocked = liveBlocked(accountId);
    if (blocked) return blocked;
    const call = store.createCall({ botId: bot.id, live: true, status: "answered", now: now() });
    return connectLive(call, bot, "inbound", request);
  }

  /** The phone answered an agent's live call. */
  async function answerOutbound(accountId: string, call: Call, request: Request) {
    if (!call.live) return err(409, "not_live", "This is not a live call");
    if (call.status !== "ringing" && call.status !== "answered") return err(409, "call_ended", "The call has ended");
    const blocked = liveBlocked(accountId);
    if (blocked) return blocked;
    store.transition(call.id, "answered", now());
    return connectLive(store.call(call.id)!, store.bot(call.bot_id)!, "outbound", request);
  }

  const ownerBot = (bot: Bot) => ({
    ...publicBot(bot),
    live: { instructions: bot.live_instructions, webhook_url: bot.webhook_url, listener: live.listenerConnected(bot.id) },
  });

  async function updateBot(bot: Bot, request: Request) {
    const body = await readJson<{ instructions?: unknown; webhook_url?: unknown }>(request);
    if (!body) return err(400, "invalid_json", "Invalid JSON");
    let instructions: string | null | undefined;
    if (body.instructions !== undefined) {
      if (body.instructions !== null && typeof body.instructions !== "string") return err(400, "invalid_instructions", "Instructions must be text");
      instructions = typeof body.instructions === "string" ? body.instructions.trim() || null : null;
      if (instructions && instructions.length > LIVE_LIMITS.instructions) {
        return err(400, "invalid_instructions", `Instructions are longer than ${LIVE_LIMITS.instructions} characters`);
      }
    }
    let webhookUrl: string | null | undefined;
    if (body.webhook_url !== undefined) {
      if (body.webhook_url !== null && typeof body.webhook_url !== "string") return err(400, "invalid_webhook_url", "Webhook URL must be text");
      webhookUrl = typeof body.webhook_url === "string" ? body.webhook_url.trim() || null : null;
      if (webhookUrl) {
        const problem = webhookUrlError(webhookUrl, allowPrivateWebhooks);
        if (problem) return err(400, "invalid_webhook_url", problem);
        if (!(await live.safeWebhook(webhookUrl))) return err(400, "invalid_webhook_url", "Webhook URL must be a public address");
      }
    }
    const secret = store.setBotLive(bot.id, { instructions, webhookUrl });
    return Response.json({ ...ownerBot(store.bot(bot.id)!), ...(secret ? { webhook_secret: secret } : {}) });
  }

  async function createBot(accountId: string, request: Request) {
    const body = await readJson<{ name?: unknown }>(request);
    if (!body) return err(400, "invalid_json", "Invalid JSON");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_NAME) return err(400, "invalid_name", `Name must be 1 to ${MAX_NAME} characters`);
    if (name === TEST_AGENT_NAME) return err(400, "invalid_name", "This name is reserved");
    if (store.botByName(accountId, name)) return err(409, "name_taken", "An agent with this name already exists");
    if (store.countBots(accountId) >= BOTS_PER_ACCOUNT) return err(403, "too_many_bots", `No more than ${BOTS_PER_ACCOUNT} agents`);
    const { id, token } = store.addBot({ accountId, name });
    return Response.json({ ...publicBot(store.bot(id)!), token }, { status: 201 });
  }

  function newPhoneSession(accountId: string, name: unknown, key?: string) {
    if (store.listDevices(accountId).length >= DEVICES_PER_ACCOUNT) {
      return err(403, "too_many_devices", `No more than ${DEVICES_PER_ACCOUNT} phones. Remove one on the website`);
    }
    const deviceName = typeof name === "string" && name.trim() ? name.trim().slice(0, MAX_NAME) : "iPhone";
    const { token } = store.addDevice(accountId, deviceName, now());
    return Response.json({ token, ...(key ? { key } : {}) }, { status: 201 });
  }

  /** Public routes: new account and sign-in by key. */
  async function publicRoute(request: Request, url: URL) {
    const { pathname } = url;
    if (request.method !== "POST") return null;
    if (pathname !== "/v1/accounts" && pathname !== "/v1/sessions" && !pathname.startsWith("/web/")) return null;
    const isWeb = pathname.startsWith("/web/");
    if (isWeb && request.headers.get("origin") !== origin) return err(403, "bad_origin", "Request refused");

    if (pathname === "/web/logout") {
      const token = readCookie(request, SESSION_COOKIE);
      if (token) store.deleteSession(token);
      return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
    }
    if (pathname === "/v1/accounts" || pathname === "/web/signup") {
      const created = accounts.create(request);
      if ("error" in created) return created.error;
      if (isWeb) {
        return Response.json({ key: created.key }, { status: 201, headers: { "set-cookie": sessionCookie(store.createSession(created.id, now())) } });
      }
      const body = await readJson<{ device_name?: unknown }>(request);
      return newPhoneSession(created.id, body?.device_name, created.key);
    }
    if (pathname === "/v1/sessions" || pathname === "/web/login") {
      const body = await readJson<{ key?: unknown; device_name?: unknown }>(request);
      if (typeof body?.key !== "string") return err(400, "invalid_key", "Enter your account key");
      const verified = accounts.verifyKey(request, body.key);
      if ("error" in verified) return verified.error;
      if (isWeb) {
        return Response.json({ ok: true }, { headers: { "set-cookie": sessionCookie(store.createSession(verified.id, now())) } });
      }
      return newPhoneSession(verified.id, body.device_name);
    }
    return err(404, "not_found", "Not found");
  }

  async function accountRoute(principal: Principal, request: Request, parts: string[]) {
    const { accountId, device } = principal;
    const [resource, id, action] = parts;
    const method = request.method;

    if (resource === "status" && method === "GET") {
      const phones = store.listDevices(accountId);
      return Response.json({
        account_id: accountId,
        push_enabled: Boolean(push),
        push_registered: device ? Boolean(device.voip_token) : phones.some((p) => p.voip_token),
        phones: phones.length,
        mcp_url: options.publicUrl ? `${options.publicUrl}/mcp` : null,
        live: {
          available: Boolean(voice),
          billing: options.billing ?? false,
          seconds_left: options.billing ? store.liveSeconds(accountId) : null,
        },
      });
    }
    if (resource === "account" && !id && method === "DELETE") {
      removeAudio(store.deleteAccount(accountId));
      return new Response(null, { status: 204, headers: device ? {} : { "set-cookie": clearSessionCookie() } });
    }
    if (resource === "device" && !id) {
      if (!device) return err(403, "forbidden", "Only for phones");
      if (method === "PUT") {
        const body = await readJson<{ voip_token?: unknown; environment?: unknown }>(request);
        if (!body) return err(400, "invalid_json", "Invalid JSON");
        const token = body.voip_token;
        if (token !== null && (typeof token !== "string" || !/^[0-9a-f]{32,200}$/i.test(token))) {
          return err(400, "invalid_token", "Invalid VoIP token");
        }
        store.setVoipToken(device.id, token as string | null, body.environment === "production" ? "production" : "sandbox");
        return Response.json({ ok: true, push_enabled: Boolean(push) });
      }
      // Sign out on a phone: the account stays.
      if (method === "DELETE") {
        store.deleteDevice(device.id);
        return new Response(null, { status: 204 });
      }
    }
    if (resource === "devices" && !id && method === "GET") {
      return Response.json({
        devices: store.listDevices(accountId).map((d) => ({ id: d.id, name: d.name, push: Boolean(d.voip_token), created_at: d.created_at, current: d.id === device?.id })),
      });
    }
    if (resource === "devices" && id && method === "DELETE") {
      const target = store.device(id);
      if (!target || target.account_id !== accountId) return err(404, "not_found", "Phone not found");
      store.deleteDevice(target.id);
      return new Response(null, { status: 204 });
    }
    if (resource === "bots" && !id && method === "GET") {
      return Response.json({ bots: store.listBots(accountId).map(ownerBot) });
    }
    if (resource === "bots" && !id && method === "POST") return createBot(accountId, request);
    if (resource === "bots" && id) {
      const bot = store.bot(id);
      // Another account's agent looks like it does not exist.
      if (!bot || bot.account_id !== accountId) return err(404, "not_found", "Agent not found");
      if (!action && method === "DELETE") {
        removeAudio(store.deleteBot(bot.id));
        return new Response(null, { status: 204 });
      }
      if (action === "chat" && method === "POST") return chat(bot, request);
      if (!action && method === "PATCH") return updateBot(bot, request);
    }
    if (resource === "live" && !id && method === "POST") {
      if (!device) return err(403, "forbidden", "Only for phones");
      return startInbound(accountId, request);
    }
    if (resource === "test-call" && !id && method === "POST") {
      const body = await readJson<Record<string, unknown>>(request);
      if (!body) return err(400, "invalid_json", "Invalid JSON");
      // Text only: a test needs no audio upload or idempotency key.
      const { status, body: result } = await placeCall(store.testAgent(accountId), { text: body.text, title: "Test call" });
      return Response.json(result, { status });
    }
    if (resource === "calls" && method === "GET" && id === "pending") {
      return Response.json({ calls: store.pendingCalls(accountId).map(publicCall) });
    }
    if (resource === "calls" && method === "GET" && !id) {
      const url = new URL(request.url);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
      return Response.json({ calls: store.listCalls(accountId, limit, url.searchParams.get("bot_id") ?? undefined).map(publicCall) });
    }
    if (resource === "calls" && id) {
      const call = store.callForAccount(id, accountId);
      if (!call) return err(404, "not_found", "Call not found");
      if (!action && method === "GET") return Response.json(publicCall(call));
      if (action === "live" && method === "POST") {
        if (!device) return err(403, "forbidden", "Only for phones");
        return answerOutbound(accountId, call, request);
      }
      if (action === "end" && method === "POST") {
        if (!device) return err(403, "forbidden", "Only for phones");
        live.end(call.id, "user_hung_up");
        return Response.json(publicCall(store.call(call.id)!));
      }
      if (action === "audio" && method === "GET") {
        const file = Bun.file(audioPath(call.id));
        if (!call.audio_mime || !(await file.exists())) return err(404, "not_found", "No audio");
        return new Response(file, { headers: { "content-type": call.audio_mime, "cache-control": "no-store" } });
      }
      if (action === "status" && method === "POST") {
        if (!device) return err(403, "forbidden", "Only for phones");
        const body = await readJson<{ status?: unknown }>(request);
        if (!body) return err(400, "invalid_json", "Invalid JSON");
        if (!DEVICE_STATUSES.includes(body.status as CallStatus)) return err(400, "invalid_status", "Invalid status");
        if (!store.transition(call.id, body.status as CallStatus, now())) {
          return err(409, "invalid_transition", `Cannot move from ${call.status} to ${String(body.status)}`);
        }
        return Response.json(publicCall(store.call(call.id)!));
      }
    }
    return err(404, "not_found", "Not found");
  }

  /** On /mcp this header tells the client where OAuth sign-in starts. */
  function unauthorized(url: URL, message: string) {
    const response = err(401, "unauthorized", message);
    if (oauth && url.pathname === "/mcp") response.headers.set("WWW-Authenticate", oauth.challengeHeader);
    return response;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (request.method === "GET" || request.method === "HEAD") {
      const page = serveSite(url.pathname);
      if (page) return page;
    }

    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_BODY_BYTES) return err(413, "too_large", "Request is too large");

    const oauthResponse = await oauth?.handle(request, url);
    if (oauthResponse) return oauthResponse;

    const opened = await publicRoute(request, url);
    if (opened) return opened;

    const token = bearer(request);
    store.expireRinging(now());

    if (url.pathname === "/mcp") {
      const bot = token ? botFor(token) : null;
      return bot ? handleMcp(bot, request, mcpActions) : unauthorized(url, token ? "Invalid agent token" : "Bearer token required");
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1") {
      // People get a page, API clients get JSON.
      if (request.method === "GET" && request.headers.get("accept")?.includes("text/html")) return notFoundPage();
      return err(404, "not_found", "Not found");
    }
    const rest = parts.slice(1);

    if (token) {
      const bot = botFor(token);
      if (bot) {
        if (rest[0] === "call" && rest.length === 1 && request.method === "POST") {
          // A call with no body is allowed.
          let args: Record<string, unknown> = {};
          const raw = await request.text();
          if (raw.trim()) {
            try {
              args = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              return err(400, "invalid_json", "Invalid JSON");
            }
          }
          const { status, body } = await placeCall(bot, args);
          return Response.json(body, { status });
        }
        if (rest[0] === "calls" && rest[1] && rest.length === 2 && request.method === "GET") {
          const { status, body } = callStatusForBot(bot, rest[1]);
          return Response.json(body, { status });
        }
        const action = rest[2] === "answers" ? "answer" : rest[2];
        if (rest[0] === "calls" && rest[1] && rest.length === 3 && request.method === "POST" && LIVE_ACTIONS.has(action!)) {
          const body = (await readJson<Record<string, unknown>>(request)) ?? {};
          const { status, body: result } = live.act(bot, rest[1], action as LiveAction, body);
          return Response.json(result, { status });
        }
        return err(403, "forbidden", "Agent tokens cannot do this");
      }
      const device = store.deviceByToken(token);
      return device ? accountRoute({ accountId: device.account_id, device }, request, rest) : err(401, "unauthorized", "Invalid token");
    }

    // Browser: session cookie. Changes only from our own site.
    const session = readCookie(request, SESSION_COOKIE);
    const accountId = session ? store.accountIdBySession(session, now()) : null;
    if (!accountId) return err(401, "unauthorized", "Sign in first");
    if (request.method !== "GET" && request.headers.get("origin") !== origin) return err(403, "bad_origin", "Request refused");
    return accountRoute({ accountId, device: null }, request, rest);
  }

  /** Agent event listener: a WebSocket on /v1/events. Returns null for other paths, undefined once upgraded. */
  function upgrade(request: Request, server: Upgrader): Response | undefined | null {
    if (new URL(request.url).pathname !== "/v1/events") return null;
    const token = bearer(request);
    const bot = token ? botFor(token) : null;
    if (!bot) return err(401, "unauthorized", "Agent token required");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return err(426, "upgrade_required", "Connect with a WebSocket");
    return server.upgrade(request, { data: { botId: bot.id } }) ? undefined : err(400, "upgrade_failed", "WebSocket upgrade failed");
  }

  const websocket = {
    open(socket: ListenerSocket) {
      live.attachListener(socket.data.botId, socket);
    },
    message(socket: ListenerSocket, message: string | Buffer) {
      const bot = store.bot(socket.data.botId);
      if (!bot) return socket.close(4001, "Agent deleted");
      live.listenerMessage(bot, socket, typeof message === "string" ? message : message.toString("utf8"));
    },
    close(socket: ListenerSocket) {
      live.detachListener(socket.data.botId, socket);
    },
  };

  function purge(maxAgeMs = 30 * DAY_MS) {
    store.purge(now());
    // Calls ring for at most a minute, so audio is useless after a day.
    removeAudio(store.callsWithAudioOlderThan(now() - DAY_MS));
    removeAudio(store.purgeOlderThan(now() - maxAgeMs));
    store.purgeAbandonedAccounts(now() - 7 * DAY_MS);
  }

  return { handle, purge, upgrade, websocket, tick: live.tick, live };
}

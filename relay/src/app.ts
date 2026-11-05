import { randomInt } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PushSender } from "./apns";
import type { Bot, Call, CallStatus, Device, Store } from "./db";
import { clientIp, WindowLimiter } from "./limits";
import { handleMcp, type McpActions } from "./mcp";
import type { OAuth } from "./oauth";
import { normalizeLanguage } from "./speech";

export const MAX_TEXT = 2000;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
export const CALLS_PER_MINUTE = 6;
export const CALLS_PER_DAY = 200;
export const AUDIO_BYTES_PER_DAY = 200 * 1024 * 1024;
export const BOTS_PER_ACCOUNT = 50;
export const REGISTRATIONS_PER_IP_HOUR = 20;
export const REGISTRATIONS_PER_HOUR = 500;
export const CONNECT_CODE_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CHAT_MESSAGES = 100;
const MAX_CHAT_CHARS = 200_000;
const MAX_BOT_NAME = 40;
const AUDIO_MIMES = new Set(["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/x-wav"]);
const DEVICE_STATUSES: readonly CallStatus[] = ["answered", "played", "declined", "missed", "failed"];
// Без похожих символов: код вводят руками.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export interface AppOptions {
  store: Store;
  dataDir: string;
  push: PushSender | null;
  oauth?: OAuth | null;
  /** Публичный адрес, который приложение показывает для подключения агентов. */
  publicUrl?: string;
  openRegistration?: boolean;
  env?: Record<string, string | undefined>;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

const err = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });

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
  created_at: call.created_at,
  updated_at: call.updated_at,
});

const publicBot = (bot: Bot) => ({
  id: bot.id,
  name: bot.name,
  capabilities: { chat: Boolean(bot.chat_url), calls: true },
});

export function newConnectCode() {
  const pick = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return Array.from({ length: 8 }, pick).join("");
}

export function createApp(options: AppOptions) {
  const { store, dataDir, push } = options;
  const oauth = options.oauth ?? null;
  const openRegistration = options.openRegistration ?? true;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const audioDir = join(dataDir, "audio");
  mkdirSync(audioDir, { recursive: true });
  const audioPath = (id: string) => join(audioDir, id);
  const removeAudio = (ids: string[]) => ids.forEach((id) => rmSync(audioPath(id), { force: true }));
  const botFor = (token: string) => store.botByToken(token) ?? oauth?.botByAccessToken(token) ?? null;
  const registerPerIp = new WindowLimiter(REGISTRATIONS_PER_IP_HOUR, 60 * 60 * 1000);
  const registerGlobal = new WindowLimiter(REGISTRATIONS_PER_HOUR, 60 * 60 * 1000, 1);

  async function ring(bot: Bot, call: Call) {
    if (!push) return { sent: false, enabled: false };
    const device = store.device(bot.device_id);
    if (!device?.voip_token) return { sent: false, enabled: true };
    const result = await push.send(device, call);
    if (result.invalidToken) store.clearVoipToken(device.voip_token);
    if (!result.ok) console.error(`push failed status=${result.status} reason=${result.reason ?? "?"}`);
    return { sent: result.ok, enabled: true };
  }

  async function placeCall(bot: Bot, args: Record<string, unknown>) {
    const text = typeof args.text === "string" ? args.text.trim().normalize("NFC") : "";
    const audioB64 = typeof args.audio_base64 === "string" ? args.audio_base64 : "";
    const title = typeof args.title === "string" ? args.title.trim().slice(0, 120) : "";
    const key = typeof args.idempotency_key === "string" && args.idempotency_key ? args.idempotency_key.slice(0, 200) : undefined;
    const reject = (code: string, message: string, status = 400) => ({ status, body: { error: { code, message } } });

    // Текст и аудио необязательны: звонок без сообщения просто звонит.
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
    const usage = store.deviceUsage(bot.device_id, now() - DAY_MS);
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
      now: now(),
    });
    if (audio) await Bun.write(audioPath(call.id), audio);
    const delivery = await ring(bot, call);
    return {
      status: 202,
      body: { ...publicCall(call), push: delivery.enabled ? (delivery.sent ? "sent" : "failed") : "disabled" },
    };
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
    let body: { messages?: unknown };
    try {
      body = (await request.json()) as { messages?: unknown };
    } catch {
      return err(400, "invalid_json", "Invalid JSON");
    }
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

  async function createBot(device: Device, request: Request) {
    let body: { name?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return err(400, "invalid_json", "Invalid JSON");
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_BOT_NAME) return err(400, "invalid_name", `Name must be 1 to ${MAX_BOT_NAME} characters`);
    if (store.botByName(device.id, name)) return err(409, "name_taken", "An agent with this name already exists");
    if (store.countBots(device.id) >= BOTS_PER_ACCOUNT) return err(403, "too_many_bots", `No more than ${BOTS_PER_ACCOUNT} agents`);
    const { id, token } = store.addBot({ deviceId: device.id, name });
    return Response.json({ ...publicBot(store.bot(id)!), token }, { status: 201 });
  }

  async function deviceRoute(device: Device, request: Request, parts: string[]) {
    const [resource, id, action] = parts;
    const method = request.method;

    if (resource === "device" && !id && method === "PUT") {
      let body: { voip_token?: unknown; environment?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return err(400, "invalid_json", "Invalid JSON");
      }
      const token = body.voip_token;
      if (token !== null && (typeof token !== "string" || !/^[0-9a-f]{32,200}$/i.test(token))) {
        return err(400, "invalid_token", "Invalid VoIP token");
      }
      const environment = body.environment === "production" ? "production" : "sandbox";
      store.setVoipToken(device.id, token as string | null, environment);
      return Response.json({ ok: true, push_enabled: Boolean(push) });
    }
    if (resource === "device" && !id && method === "DELETE") {
      removeAudio(store.deleteDevice(device.id));
      return new Response(null, { status: 204 });
    }
    if (resource === "status" && method === "GET") {
      return Response.json({ push_enabled: Boolean(push), push_registered: Boolean(device.voip_token), mcp_url: options.publicUrl ? `${options.publicUrl}/mcp` : null });
    }
    if (resource === "connect-codes" && !id && method === "POST") {
      if (!oauth) return err(409, "oauth_disabled", "Browser sign-in is off on this server");
      const code = newConnectCode();
      const expiresAt = now() + CONNECT_CODE_TTL_MS;
      store.addConnectCode(code, device.id, expiresAt);
      return Response.json({ code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at: expiresAt }, { status: 201 });
    }
    if (resource === "bots" && !id && method === "GET") {
      return Response.json({ bots: store.listBots(device.id).map(publicBot) });
    }
    if (resource === "bots" && !id && method === "POST") return createBot(device, request);
    if (resource === "bots" && id) {
      const bot = store.bot(id);
      // Чужой бот выглядит как несуществующий.
      if (!bot || bot.device_id !== device.id) return err(404, "not_found", "Agent not found");
      if (!action && method === "DELETE") {
        removeAudio(store.deleteBot(bot.id));
        return new Response(null, { status: 204 });
      }
      if (action === "chat" && method === "POST") return chat(bot, request);
    }
    if (resource === "calls" && method === "GET" && id === "pending") {
      return Response.json({ calls: store.pendingCalls(device.id).map(publicCall) });
    }
    if (resource === "calls" && method === "GET" && !id) {
      const url = new URL(request.url);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
      return Response.json({ calls: store.listCalls(device.id, limit, url.searchParams.get("bot_id") ?? undefined).map(publicCall) });
    }
    if (resource === "calls" && id) {
      const call = store.callForDevice(id, device.id);
      if (!call) return err(404, "not_found", "Call not found");
      if (!action && method === "GET") return Response.json(publicCall(call));
      if (action === "audio" && method === "GET") {
        const file = Bun.file(audioPath(call.id));
        if (!call.audio_mime || !(await file.exists())) return err(404, "not_found", "No audio");
        return new Response(file, { headers: { "content-type": call.audio_mime, "cache-control": "no-store" } });
      }
      if (action === "status" && method === "POST") {
        let body: { status?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return err(400, "invalid_json", "Invalid JSON");
        }
        if (!DEVICE_STATUSES.includes(body.status as CallStatus)) return err(400, "invalid_status", "Invalid status");
        if (!store.transition(call.id, body.status as CallStatus, now())) {
          return err(409, "invalid_transition", `Cannot move from ${call.status} to ${String(body.status)}`);
        }
        return Response.json(publicCall(store.call(call.id)!));
      }
    }
    return err(404, "not_found", "Not found");
  }

  function register(request: Request) {
    if (!openRegistration) return err(403, "registration_closed", "Registration is closed on this server");
    const ip = clientIp(request);
    if (registerPerIp.exceeded(ip, now()) || registerGlobal.exceeded("all", now())) {
      return err(429, "rate_limited", "Too many new accounts. Try again later");
    }
    registerPerIp.record(ip, now());
    registerGlobal.record("all", now());
    const { token } = store.registerDevice(now());
    return Response.json({ token }, { status: 201 });
  }

  /** На /mcp клиент узнаёт из заголовка, где начинается вход через OAuth. */
  function unauthorized(url: URL, message: string) {
    const response = err(401, "unauthorized", message);
    if (oauth && url.pathname === "/mcp") response.headers.set("WWW-Authenticate", oauth.challengeHeader);
    return response;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, push_enabled: Boolean(push), open_registration: openRegistration });

    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_BODY_BYTES) return err(413, "too_large", "Request is too large");

    const oauthResponse = await oauth?.handle(request, url);
    if (oauthResponse) return oauthResponse;

    if (url.pathname === "/v1/register" && request.method === "POST") return register(request);

    const token = bearer(request);
    if (!token) return unauthorized(url, "Bearer token required");

    store.expireRinging(now());

    if (url.pathname === "/mcp") {
      const bot = botFor(token);
      return bot ? handleMcp(bot, request, mcpActions) : unauthorized(url, "Invalid agent token");
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1") return err(404, "not_found", "Not found");
    const rest = parts.slice(1);

    const bot = botFor(token);
    if (bot) {
      if (rest[0] === "call" && rest.length === 1 && request.method === "POST") {
        // Звонок без тела тоже допустим.
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
      return err(403, "forbidden", "Agent tokens cannot do this");
    }

    const device = store.deviceByToken(token);
    if (device) return deviceRoute(device, request, rest);
    return err(401, "unauthorized", "Invalid token");
  }

  function purge(maxAgeMs = 30 * DAY_MS) {
    store.purgeOAuth(now());
    // Звонят максимум минуту, поэтому аудио после суток не нужно.
    removeAudio(store.callsWithAudioOlderThan(now() - DAY_MS));
    removeAudio(store.purgeOlderThan(now() - maxAgeMs));
    store.purgeAbandonedDevices(now() - 7 * DAY_MS);
  }

  return { handle, purge };
}

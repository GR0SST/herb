import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";

export type CallStatus = "ringing" | "answered" | "played" | "ended" | "declined" | "missed" | "failed";
const TERMINAL: readonly CallStatus[] = ["played", "ended", "declined", "missed", "failed"];
const TRANSITIONS: Record<CallStatus, readonly CallStatus[]> = {
  ringing: ["answered", "declined", "missed", "failed"],
  // "played" ends a one-way call, "ended" a live one.
  answered: ["played", "ended", "failed"],
  played: [],
  ended: [],
  declined: [],
  missed: [],
  failed: [],
};

export interface Bot {
  id: string;
  account_id: string;
  name: string;
  chat_url: string | null;
  chat_key_env: string | null;
  chat_model: string | null;
  live_instructions: string | null;
  webhook_url: string | null;
  webhook_secret: string | null;
}

export interface Device {
  id: string;
  account_id: string;
  name: string;
  voip_token: string | null;
  environment: "sandbox" | "production";
  created_at: number;
}

export interface Call {
  id: string;
  bot_id: string;
  bot_name: string;
  title: string | null;
  text: string | null;
  language: string | null;
  audio_mime: string | null;
  status: CallStatus;
  live: number;
  ended_reason: string | null;
  duration_s: number | null;
  /** What the calling agent told the voice agent for a live call. */
  live_context: string | null;
  /** JSON list of {role, text} after a live call. */
  transcript: string | null;
  /** 1 when the user called the agent from the phone. */
  from_phone: number;
  created_at: number;
  updated_at: number;
}

export interface OAuthClient {
  id: string;
  name: string;
  redirect_uris: string[];
}

export interface OAuthGrant {
  id: string;
  client_id: string;
  bot_id: string;
  refresh_expires: number;
}

export const RING_TIMEOUT_MS = 60_000;
/** Internal agent for test calls. Hidden from the agent list, and its name is reserved. */
export const TEST_AGENT_NAME = "Test call";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// No lookalike characters, since keys may be typed by hand.
const KEY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const KEY_LENGTH = 20;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

/** An account key can be typed in any case, with dashes or spaces. */
export const normalizeKey = (value: string) => value.toUpperCase().replace(/[^0-9A-Z]/g, "");

function newAccountKey() {
  const raw = Array.from({ length: KEY_LENGTH }, () => KEY_ALPHABET[randomInt(KEY_ALPHABET.length)]).join("");
  return raw.match(/.{4}/g)!.join("-");
}

const BOT_COLUMNS = "id, account_id, name, chat_url, chat_key_env, chat_model, live_instructions, webhook_url, webhook_secret";
const DEVICE_COLUMNS = "id, account_id, name, voip_token, environment, created_at";
const CALL_SELECT = `SELECT c.id, c.bot_id, b.name AS bot_name, c.title, c.text, c.language, c.audio_mime, c.status, c.live, c.ended_reason, c.duration_s, c.live_context, c.transcript, c.from_phone, c.created_at, c.updated_at
  FROM calls c JOIN bots b ON b.id = c.bot_id`;

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      voip_token TEXT, environment TEXT NOT NULL DEFAULT 'sandbox', created_at INTEGER NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      chat_url TEXT, chat_key_env TEXT, chat_model TEXT,
      UNIQUE (account_id, name)
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      title TEXT, text TEXT, language TEXT, audio_mime TEXT, audio_bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, idempotency_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (bot_id, idempotency_key)
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS calls_created ON calls(created_at DESC)");
    const botColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(bots)").all();
    if (!botColumns.some((c) => c.name === "system")) this.db.run("ALTER TABLE bots ADD COLUMN system INTEGER NOT NULL DEFAULT 0");
    for (const column of ["live_instructions", "webhook_url", "webhook_secret"]) {
      if (!botColumns.some((c) => c.name === column)) this.db.run(`ALTER TABLE bots ADD COLUMN ${column} TEXT`);
    }
    const callColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(calls)").all();
    if (!callColumns.some((c) => c.name === "live")) {
      this.db.run("ALTER TABLE calls ADD COLUMN live INTEGER NOT NULL DEFAULT 0");
      this.db.run("ALTER TABLE calls ADD COLUMN ended_reason TEXT");
      this.db.run("ALTER TABLE calls ADD COLUMN duration_s INTEGER");
    }
    for (const column of ["live_context", "transcript"]) {
      if (!callColumns.some((c) => c.name === column)) this.db.run(`ALTER TABLE calls ADD COLUMN ${column} TEXT`);
    }
    if (!callColumns.some((c) => c.name === "from_phone")) {
      this.db.run("ALTER TABLE calls ADD COLUMN from_phone INTEGER NOT NULL DEFAULT 0");
      // Earlier calls from the phone: live, with no message or subject from an agent.
      this.db.run("UPDATE calls SET from_phone = 1 WHERE live = 1 AND text IS NULL AND title IS NULL");
    }
    // Paid live call time left, in seconds.
    this.db.run(`CREATE TABLE IF NOT EXISTS live_balance (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      seconds INTEGER NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS oauth_clients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS oauth_grants (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      access_hash TEXT NOT NULL UNIQUE, access_expires INTEGER NOT NULL,
      refresh_hash TEXT NOT NULL UNIQUE, refresh_expires INTEGER NOT NULL,
      previous_refresh_hash TEXT
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS oauth_prev ON oauth_grants(previous_refresh_hash)");
  }

  // Accounts

  createAccount(now: number) {
    const id = randomUUID();
    const key = newAccountKey();
    this.db.query("INSERT INTO accounts (id, key_hash, created_at) VALUES (?, ?, ?)").run(id, hashToken(normalizeKey(key)), now);
    return { id, key };
  }

  accountIdByKey(key: string) {
    return this.db.query<{ id: string }, [string]>("SELECT id FROM accounts WHERE key_hash = ?").get(hashToken(normalizeKey(key)))?.id ?? null;
  }

  accountExists(id: string) {
    return this.db.query("SELECT 1 FROM accounts WHERE id = ?").get(id) !== null;
  }

  /** Returns call ids so their audio can be deleted. */
  deleteAccount(id: string) {
    const calls = this.db
      .query<{ id: string }, [string]>("SELECT c.id FROM calls c JOIN bots b ON b.id = c.bot_id WHERE b.account_id = ?")
      .all(id);
    this.db.query("DELETE FROM accounts WHERE id = ?").run(id);
    return calls.map((c) => c.id);
  }

  /** Abandoned accounts: no phone and no agent. */
  purgeAbandonedAccounts(cutoff: number) {
    this.db
      .query(`DELETE FROM accounts WHERE created_at < ?
              AND id NOT IN (SELECT account_id FROM devices) AND id NOT IN (SELECT account_id FROM bots)`)
      .run(cutoff);
  }

  // Web sessions

  createSession(accountId: string, now: number) {
    const token = randomBytes(32).toString("base64url");
    this.db.query("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)").run(hashToken(token), accountId, now + SESSION_TTL_MS);
    return token;
  }

  accountIdBySession(token: string, now: number) {
    return this.db
      .query<{ account_id: string }, [string, number]>("SELECT account_id FROM sessions WHERE token_hash = ? AND expires_at > ?")
      .get(hashToken(token), now)?.account_id ?? null;
  }

  deleteSession(token: string) {
    this.db.query("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }

  // Phones

  addDevice(accountId: string, name: string, now: number) {
    const id = randomUUID();
    const token = newToken("herb_dev");
    this.db.query("INSERT INTO devices (id, account_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(id, accountId, name, hashToken(token), now);
    return { id, token };
  }

  deviceByToken(token: string) {
    return this.db.query<Device, [string]>(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE token_hash = ?`).get(hashToken(token));
  }

  device(id: string) {
    return this.db.query<Device, [string]>(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = ?`).get(id);
  }

  listDevices(accountId: string) {
    return this.db.query<Device, [string]>(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE account_id = ? ORDER BY created_at`).all(accountId);
  }

  deleteDevice(id: string) {
    this.db.query("DELETE FROM devices WHERE id = ?").run(id);
  }

  setVoipToken(deviceId: string, token: string | null, environment: Device["environment"]) {
    // A token belongs to one device, so changing accounts clears the old record.
    if (token) this.db.query("UPDATE devices SET voip_token = NULL WHERE voip_token = ? AND id != ?").run(token, deviceId);
    this.db.query("UPDATE devices SET voip_token = ?, environment = ? WHERE id = ?").run(token, environment, deviceId);
  }

  clearVoipToken(token: string) {
    this.db.query("UPDATE devices SET voip_token = NULL WHERE voip_token = ?").run(token);
  }

  // Agents

  addBot(opts: { accountId: string; name: string }) {
    const id = randomUUID();
    const token = newToken("herb_bot");
    this.db
      .query("INSERT INTO bots (id, account_id, name, token_hash) VALUES (?, ?, ?, ?)")
      .run(id, opts.accountId, opts.name, hashToken(token));
    return { id, token };
  }

  botByToken(token: string) {
    return this.db.query<Bot, [string]>(`SELECT ${BOT_COLUMNS} FROM bots WHERE token_hash = ?`).get(hashToken(token));
  }

  bot(id: string) {
    return this.db.query<Bot, [string]>(`SELECT ${BOT_COLUMNS} FROM bots WHERE id = ?`).get(id);
  }

  botByName(accountId: string, name: string) {
    return this.db.query<Bot, [string, string]>(`SELECT ${BOT_COLUMNS} FROM bots WHERE account_id = ? AND name = ?`).get(accountId, name);
  }

  listBots(accountId: string) {
    return this.db.query<Bot, [string]>(`SELECT ${BOT_COLUMNS} FROM bots WHERE account_id = ? AND system = 0 ORDER BY name`).all(accountId);
  }

  countBots(accountId: string) {
    return this.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM bots WHERE account_id = ? AND system = 0").get(accountId)!.n;
  }

  /** Created on the first test call. */
  testAgent(accountId: string) {
    const existing = this.db.query<Bot, [string]>(`SELECT ${BOT_COLUMNS} FROM bots WHERE account_id = ? AND system = 1`).get(accountId);
    if (existing) return existing;
    const { id } = this.addBot({ accountId, name: TEST_AGENT_NAME });
    this.db.query("UPDATE bots SET system = 1 WHERE id = ?").run(id);
    return this.bot(id)!;
  }

  setBotChat(id: string, chat: { url: string | null; keyEnv: string | null; model: string | null }) {
    this.db.query("UPDATE bots SET chat_url = ?, chat_key_env = ?, chat_model = ? WHERE id = ?").run(chat.url, chat.keyEnv, chat.model, id);
  }

  /**
   * Saves the voice agent's instructions and webhook. The secret can come from the receiving service;
   * otherwise a new webhook URL gets a generated one. Returns a generated secret so it can be shown once.
   */
  setBotLive(id: string, live: { instructions?: string | null; webhookUrl?: string | null; webhookSecret?: string }) {
    if (live.instructions !== undefined) this.db.query("UPDATE bots SET live_instructions = ? WHERE id = ?").run(live.instructions, id);
    if (live.webhookUrl === null) {
      this.db.query("UPDATE bots SET webhook_url = NULL, webhook_secret = NULL WHERE id = ?").run(id);
      return null;
    }
    if (live.webhookUrl !== undefined) this.db.query("UPDATE bots SET webhook_url = ? WHERE id = ?").run(live.webhookUrl, id);
    if (live.webhookSecret) {
      this.db.query("UPDATE bots SET webhook_secret = ? WHERE id = ?").run(live.webhookSecret, id);
      return null;
    }
    if (live.webhookUrl === undefined) return null;
    // Standard Webhooks format: whsec_ and base64.
    const secret = `whsec_${randomBytes(24).toString("base64")}`;
    this.db.query("UPDATE bots SET webhook_secret = ? WHERE id = ?").run(secret, id);
    return secret;
  }

  /** Returns the removed agent's call ids so their audio can be deleted. */
  deleteBot(id: string) {
    const calls = this.db.query<{ id: string }, [string]>("SELECT id FROM calls WHERE bot_id = ?").all(id);
    this.db.query("DELETE FROM bots WHERE id = ?").run(id);
    return calls.map((c) => c.id);
  }

  // Calls

  recentCallCount(botId: string, sinceMs: number) {
    return this.db
      .query<{ n: number }, [string, number]>("SELECT count(*) AS n FROM calls WHERE bot_id = ? AND created_at >= ?")
      .get(botId, sinceMs)!.n;
  }

  accountUsage(accountId: string, sinceMs: number) {
    return this.db
      .query<{ calls: number; bytes: number | null }, [string, number]>(
        `SELECT count(*) AS calls, sum(c.audio_bytes) AS bytes FROM calls c JOIN bots b ON b.id = c.bot_id
         WHERE b.account_id = ? AND c.created_at >= ?`,
      )
      .get(accountId, sinceMs)!;
  }

  callByIdempotencyKey(botId: string, key: string) {
    return this.db
      .query<Call, [string, string]>(`${CALL_SELECT} WHERE c.bot_id = ? AND c.idempotency_key = ?`)
      .get(botId, key);
  }

  createCall(input: {
    botId: string;
    title?: string;
    text?: string;
    language?: string;
    audioMime?: string;
    audioBytes?: number;
    idempotencyKey?: string;
    live?: boolean;
    liveContext?: string;
    /** A call started from the phone is answered from the start. */
    status?: "ringing" | "answered";
    now: number;
  }) {
    const id = randomUUID();
    this.db
      .query(
        `INSERT INTO calls (id, bot_id, title, text, language, audio_mime, audio_bytes, status, idempotency_key, live, live_context, from_phone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.botId, input.title ?? null, input.text ?? null, input.language ?? null, input.audioMime ?? null,
        input.audioBytes ?? 0, input.status ?? "ringing", input.idempotencyKey ?? null, input.live ? 1 : 0, input.liveContext ?? null,
        input.status === "answered" ? 1 : 0, input.now, input.now);
    return this.call(id)!;
  }

  call(id: string) {
    return this.db.query<Call, [string]>(`${CALL_SELECT} WHERE c.id = ?`).get(id);
  }

  /** A call is visible only to the agent's owner. */
  callForAccount(id: string, accountId: string) {
    return this.db.query<Call, [string, string]>(`${CALL_SELECT} WHERE c.id = ? AND b.account_id = ?`).get(id, accountId);
  }

  listCalls(accountId: string, limit: number, botId?: string) {
    return botId
      ? this.db.query<Call, [string, string, number]>(`${CALL_SELECT} WHERE b.account_id = ? AND c.bot_id = ? ORDER BY c.created_at DESC LIMIT ?`).all(accountId, botId, limit)
      : this.db.query<Call, [string, number]>(`${CALL_SELECT} WHERE b.account_id = ? ORDER BY c.created_at DESC LIMIT ?`).all(accountId, limit);
  }

  pendingCalls(accountId: string) {
    return this.db.query<Call, [string]>(`${CALL_SELECT} WHERE b.account_id = ? AND c.status = 'ringing' ORDER BY c.created_at`).all(accountId);
  }

  /** Returns false if the transition is not allowed, such as after the call ended. */
  transition(id: string, next: CallStatus, now: number) {
    const current = this.call(id);
    if (!current) return false;
    if (current.status === next) return true;
    if (!TRANSITIONS[current.status].includes(next)) return false;
    this.db.query("UPDATE calls SET status = ?, updated_at = ? WHERE id = ?").run(next, now, id);
    return true;
  }

  endLiveCall(id: string, reason: string, durationS: number, now: number, transcript: unknown[] = []) {
    if (!this.transition(id, reason === "failed" ? "failed" : "ended", now)) return false;
    this.db
      .query("UPDATE calls SET ended_reason = ?, duration_s = ?, transcript = ? WHERE id = ?")
      .run(reason, durationS, transcript.length ? JSON.stringify(transcript) : null, id);
    return true;
  }

  // Live call minutes

  liveSeconds(accountId: string) {
    return this.db.query<{ seconds: number }, [string]>("SELECT seconds FROM live_balance WHERE account_id = ?").get(accountId)?.seconds ?? 0;
  }

  /** Adds or, with a negative number, spends seconds. The balance never goes below zero. */
  addLiveSeconds(accountId: string, delta: number) {
    this.db
      .query(`INSERT INTO live_balance (account_id, seconds) VALUES (?, max(0, ?))
              ON CONFLICT (account_id) DO UPDATE SET seconds = max(0, seconds + ?)`)
      .run(accountId, Math.round(delta), Math.round(delta));
  }

  expireRinging(now: number) {
    this.db
      .query("UPDATE calls SET status = 'missed', updated_at = ? WHERE status = 'ringing' AND created_at < ?")
      .run(now, now - RING_TIMEOUT_MS);
  }

  /** Deletes old finished calls and returns their ids for audio cleanup. */
  purgeOlderThan(cutoff: number) {
    const placeholders = TERMINAL.map(() => "?").join(",");
    const rows = this.db
      .query<{ id: string }, [number, ...string[]]>(
        `DELETE FROM calls WHERE created_at < ? AND status IN (${placeholders}) RETURNING id`,
      )
      .all(cutoff, ...TERMINAL);
    return rows.map((r) => r.id);
  }

  callsWithAudioOlderThan(cutoff: number) {
    return this.db
      .query<{ id: string }, [number]>("SELECT id FROM calls WHERE audio_mime IS NOT NULL AND created_at < ?")
      .all(cutoff)
      .map((r) => r.id);
  }

  // OAuth

  addOAuthClient(id: string, name: string, redirectUris: string[], now: number) {
    this.db.query("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)").run(id, name, JSON.stringify(redirectUris), now);
  }

  oauthClient(id: string): OAuthClient | null {
    const row = this.db.query<{ id: string; name: string; redirect_uris: string }, [string]>("SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?").get(id);
    return row ? { id: row.id, name: row.name, redirect_uris: JSON.parse(row.redirect_uris) as string[] } : null;
  }

  addOAuthGrant(g: { id: string; clientId: string; botId: string; accessHash: string; accessExpires: number; refreshHash: string; refreshExpires: number }) {
    this.db
      .query("INSERT INTO oauth_grants (id, client_id, bot_id, access_hash, access_expires, refresh_hash, refresh_expires) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(g.id, g.clientId, g.botId, g.accessHash, g.accessExpires, g.refreshHash, g.refreshExpires);
  }

  rotateOAuthGrant(id: string, g: { accessHash: string; accessExpires: number; refreshHash: string; refreshExpires: number; previousRefreshHash: string }) {
    this.db
      .query("UPDATE oauth_grants SET access_hash = ?, access_expires = ?, refresh_hash = ?, refresh_expires = ?, previous_refresh_hash = ? WHERE id = ?")
      .run(g.accessHash, g.accessExpires, g.refreshHash, g.refreshExpires, g.previousRefreshHash, id);
  }

  oauthGrantByRefresh(hash: string) {
    return this.db.query<OAuthGrant, [string]>("SELECT id, client_id, bot_id, refresh_expires FROM oauth_grants WHERE refresh_hash = ?").get(hash);
  }

  oauthGrantByPreviousRefresh(hash: string) {
    return this.db.query<OAuthGrant, [string]>("SELECT id, client_id, bot_id, refresh_expires FROM oauth_grants WHERE previous_refresh_hash = ?").get(hash);
  }

  deleteOAuthGrant(id: string) {
    this.db.query("DELETE FROM oauth_grants WHERE id = ?").run(id);
  }

  deleteOAuthGrantByToken(hash: string) {
    this.db.query("DELETE FROM oauth_grants WHERE access_hash = ? OR refresh_hash = ?").run(hash, hash);
  }

  botByOAuthAccess(hash: string, now: number) {
    const columns = BOT_COLUMNS.split(", ").map((c) => `b.${c}`).join(", ");
    return this.db
      .query<Bot, [string, number]>(
        `SELECT ${columns} FROM oauth_grants g JOIN bots b ON b.id = g.bot_id
         WHERE g.access_hash = ? AND g.access_expires > ?`,
      )
      .get(hash, now);
  }

  purge(now: number) {
    this.db.query("DELETE FROM oauth_grants WHERE refresh_expires < ?").run(now);
    this.db.query("DELETE FROM sessions WHERE expires_at < ?").run(now);
    // The client registered but never finished signing in.
    this.db.query("DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT client_id FROM oauth_grants)").run(now - 24 * 60 * 60 * 1000);
  }
}

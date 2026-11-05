import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export type CallStatus = "ringing" | "answered" | "played" | "declined" | "missed" | "failed";
const TERMINAL: readonly CallStatus[] = ["played", "declined", "missed", "failed"];
const TRANSITIONS: Record<CallStatus, readonly CallStatus[]> = {
  ringing: ["answered", "declined", "missed", "failed"],
  answered: ["played", "failed"],
  played: [],
  declined: [],
  missed: [],
  failed: [],
};

export interface Bot {
  id: string;
  device_id: string;
  name: string;
  chat_url: string | null;
  chat_key_env: string | null;
  chat_model: string | null;
}

/** Аккаунт: один телефон. */
export interface Device {
  id: string;
  name: string;
  voip_token: string | null;
  environment: "sandbox" | "production";
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

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

const BOT_COLUMNS = "id, device_id, name, chat_url, chat_key_env, chat_model";
const CALL_SELECT = `SELECT c.id, c.bot_id, b.name AS bot_name, c.title, c.text, c.language, c.audio_mime, c.status, c.created_at, c.updated_at
  FROM calls c JOIN bots b ON b.id = c.bot_id`;

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE,
      voip_token TEXT, environment TEXT NOT NULL DEFAULT 'sandbox'
    )`);
    this.migrateBots();
    this.db.run(`CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      title TEXT, text TEXT, audio_mime TEXT, status TEXT NOT NULL,
      idempotency_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (bot_id, idempotency_key)
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS calls_created ON calls(created_at DESC)");
    this.addColumn("calls", "language", "TEXT");
    this.addColumn("calls", "audio_bytes", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("devices", "created_at", "INTEGER NOT NULL DEFAULT 0");
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
    this.db.run(`CREATE TABLE IF NOT EXISTS connect_codes (
      code_hash TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    )`);
  }

  private columns(table: string) {
    return this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  }

  private addColumn(table: string, column: string, definition: string) {
    if (!this.columns(table).includes(column)) this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /** Боты принадлежат аккаунту. Старая база с одним владельцем целиком переходит к первому телефону. */
  private migrateBots() {
    const create = (name: string) => `CREATE TABLE ${name} (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      chat_url TEXT, chat_key_env TEXT, chat_model TEXT,
      UNIQUE (device_id, name)
    )`;
    const existing = this.columns("bots");
    if (existing.length === 0) {
      this.db.run(create("bots"));
      return;
    }
    if (existing.includes("device_id")) return;

    this.db.run("PRAGMA foreign_keys = OFF");
    this.db.transaction(() => {
      let owner = this.db.query<{ id: string }, []>("SELECT id FROM devices ORDER BY rowid LIMIT 1").get()?.id;
      const botCount = this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM bots").get()!.n;
      if (!owner && botCount > 0) owner = this.addDevice("owner").id;
      this.db.run(create("bots_new"));
      if (owner) {
        this.db
          .query(`INSERT INTO bots_new (id, device_id, name, token_hash, chat_url, chat_key_env, chat_model)
                  SELECT id, ?, name, token_hash, chat_url, chat_key_env, chat_model FROM bots`)
          .run(owner);
      }
      this.db.run("DROP TABLE bots");
      this.db.run("ALTER TABLE bots_new RENAME TO bots");
    })();
    this.db.run("PRAGMA foreign_keys = ON");
  }

  // Аккаунты

  addDevice(name: string, now = Date.now()) {
    const id = randomUUID();
    const token = newToken("herb_dev");
    this.db.query("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)").run(id, name, hashToken(token), now);
    return { id, token };
  }

  /** Анонимный аккаунт: имя служебное, в приложении его не видно. */
  registerDevice(now: number) {
    return this.addDevice(`device-${randomBytes(6).toString("hex")}`, now);
  }

  deviceByToken(token: string) {
    return this.db
      .query<Device, [string]>("SELECT id, name, voip_token, environment FROM devices WHERE token_hash = ?")
      .get(hashToken(token));
  }

  device(id: string) {
    return this.db.query<Device, [string]>("SELECT id, name, voip_token, environment FROM devices WHERE id = ?").get(id);
  }

  deviceByName(name: string) {
    return this.db.query<Device, [string]>("SELECT id, name, voip_token, environment FROM devices WHERE name = ?").get(name);
  }

  listDevices() {
    return this.db.query<Device, []>("SELECT id, name, voip_token, environment FROM devices ORDER BY name").all();
  }

  removeDevice(name: string) {
    return this.db.query("DELETE FROM devices WHERE name = ?").run(name).changes > 0;
  }

  /** Возвращает id звонков, чтобы удалить их аудио. */
  deleteDevice(id: string) {
    const calls = this.db
      .query<{ id: string }, [string]>("SELECT c.id FROM calls c JOIN bots b ON b.id = c.bot_id WHERE b.device_id = ?")
      .all(id);
    this.db.query("DELETE FROM devices WHERE id = ?").run(id);
    return calls.map((c) => c.id);
  }

  setVoipToken(deviceId: string, token: string | null, environment: Device["environment"]) {
    // Токен принадлежит одному устройству: при смене регистрации старая запись сбрасывается.
    if (token) this.db.query("UPDATE devices SET voip_token = NULL WHERE voip_token = ? AND id != ?").run(token, deviceId);
    this.db.query("UPDATE devices SET voip_token = ?, environment = ? WHERE id = ?").run(token, environment, deviceId);
  }

  clearVoipToken(token: string) {
    this.db.query("UPDATE devices SET voip_token = NULL WHERE voip_token = ?").run(token);
  }

  // Боты

  addBot(opts: { deviceId: string; name: string; chatUrl?: string; chatKeyEnv?: string; chatModel?: string }) {
    const id = randomUUID();
    const token = newToken("herb_bot");
    this.db
      .query("INSERT INTO bots (id, device_id, name, token_hash, chat_url, chat_key_env, chat_model) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, opts.deviceId, opts.name, hashToken(token), opts.chatUrl ?? null, opts.chatKeyEnv ?? null, opts.chatModel ?? null);
    return { id, token };
  }

  botByToken(token: string) {
    return this.db.query<Bot, [string]>(`SELECT ${BOT_COLUMNS} FROM bots WHERE token_hash = ?`).get(hashToken(token));
  }

  bot(id: string) {
    return this.db.query<Bot, [string]>(`SELECT ${BOT_COLUMNS} FROM bots WHERE id = ?`).get(id);
  }

  botByName(deviceId: string, name: string) {
    return this.db.query<Bot, [string, string]>(`SELECT ${BOT_COLUMNS} FROM bots WHERE device_id = ? AND name = ?`).get(deviceId, name);
  }

  listBots(deviceId: string) {
    return this.db.query<Bot, [string]>(`SELECT ${BOT_COLUMNS} FROM bots WHERE device_id = ? ORDER BY name`).all(deviceId);
  }

  allBots() {
    return this.db.query<Bot, []>(`SELECT ${BOT_COLUMNS} FROM bots ORDER BY device_id, name`).all();
  }

  countBots(deviceId: string) {
    return this.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM bots WHERE device_id = ?").get(deviceId)!.n;
  }

  setBotChat(id: string, chat: { url: string | null; keyEnv: string | null; model: string | null }) {
    this.db.query("UPDATE bots SET chat_url = ?, chat_key_env = ?, chat_model = ? WHERE id = ?").run(chat.url, chat.keyEnv, chat.model, id);
  }

  /** Возвращает id звонков удалённого бота, чтобы убрать их аудио. */
  deleteBot(id: string) {
    const calls = this.db.query<{ id: string }, [string]>("SELECT id FROM calls WHERE bot_id = ?").all(id);
    this.db.query("DELETE FROM bots WHERE id = ?").run(id);
    return calls.map((c) => c.id);
  }

  // Звонки

  recentCallCount(botId: string, sinceMs: number) {
    return this.db
      .query<{ n: number }, [string, number]>("SELECT count(*) AS n FROM calls WHERE bot_id = ? AND created_at >= ?")
      .get(botId, sinceMs)!.n;
  }

  deviceUsage(deviceId: string, sinceMs: number) {
    return this.db
      .query<{ calls: number; bytes: number | null }, [string, number]>(
        `SELECT count(*) AS calls, sum(c.audio_bytes) AS bytes FROM calls c JOIN bots b ON b.id = c.bot_id
         WHERE b.device_id = ? AND c.created_at >= ?`,
      )
      .get(deviceId, sinceMs)!;
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
    now: number;
  }) {
    const id = randomUUID();
    this.db
      .query(
        `INSERT INTO calls (id, bot_id, title, text, language, audio_mime, audio_bytes, status, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ringing', ?, ?, ?)`,
      )
      .run(id, input.botId, input.title ?? null, input.text ?? null, input.language ?? null, input.audioMime ?? null,
        input.audioBytes ?? 0, input.idempotencyKey ?? null, input.now, input.now);
    return this.call(id)!;
  }

  call(id: string) {
    return this.db.query<Call, [string]>(`${CALL_SELECT} WHERE c.id = ?`).get(id);
  }

  /** Звонок виден только владельцу бота. */
  callForDevice(id: string, deviceId: string) {
    return this.db.query<Call, [string, string]>(`${CALL_SELECT} WHERE c.id = ? AND b.device_id = ?`).get(id, deviceId);
  }

  listCalls(deviceId: string, limit: number, botId?: string) {
    return botId
      ? this.db.query<Call, [string, string, number]>(`${CALL_SELECT} WHERE b.device_id = ? AND c.bot_id = ? ORDER BY c.created_at DESC LIMIT ?`).all(deviceId, botId, limit)
      : this.db.query<Call, [string, number]>(`${CALL_SELECT} WHERE b.device_id = ? ORDER BY c.created_at DESC LIMIT ?`).all(deviceId, limit);
  }

  pendingCalls(deviceId: string) {
    return this.db.query<Call, [string]>(`${CALL_SELECT} WHERE b.device_id = ? AND c.status = 'ringing' ORDER BY c.created_at`).all(deviceId);
  }

  /** Возвращает false, если переход недопустим (например, повтор после завершения). */
  transition(id: string, next: CallStatus, now: number) {
    const current = this.call(id);
    if (!current) return false;
    if (current.status === next) return true;
    if (!TRANSITIONS[current.status].includes(next)) return false;
    this.db.query("UPDATE calls SET status = ?, updated_at = ? WHERE id = ?").run(next, now, id);
    return true;
  }

  expireRinging(now: number) {
    this.db
      .query("UPDATE calls SET status = 'missed', updated_at = ? WHERE status = 'ringing' AND created_at < ?")
      .run(now, now - RING_TIMEOUT_MS);
  }

  /** Удаляет старые завершённые звонки и возвращает их id для очистки аудио. */
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

  /** Брошенные аккаунты: телефон не подключил пуши и ботов нет. */
  purgeAbandonedDevices(cutoff: number) {
    this.db
      .query(`DELETE FROM devices WHERE created_at > 0 AND created_at < ? AND voip_token IS NULL
              AND id NOT IN (SELECT device_id FROM bots)`)
      .run(cutoff);
  }

  // Коды подключения

  addConnectCode(code: string, deviceId: string, expiresAt: number) {
    this.db.query("DELETE FROM connect_codes WHERE device_id = ?").run(deviceId);
    this.db.query("INSERT INTO connect_codes (code_hash, device_id, expires_at) VALUES (?, ?, ?)").run(hashToken(code), deviceId, expiresAt);
  }

  /** Одноразовый: код удаляется при успешной проверке. */
  consumeConnectCode(code: string, now: number) {
    const row = this.db
      .query<{ device_id: string }, [string, number]>("DELETE FROM connect_codes WHERE code_hash = ? AND expires_at >= ? RETURNING device_id")
      .get(hashToken(code), now);
    return row?.device_id ?? null;
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

  purgeOAuth(now: number) {
    this.db.query("DELETE FROM oauth_grants WHERE refresh_expires < ?").run(now);
    this.db.query("DELETE FROM connect_codes WHERE expires_at < ?").run(now);
    // Клиент зарегистрировался, но вход так и не завершил.
    this.db.query("DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT client_id FROM oauth_grants)").run(now - 24 * 60 * 60 * 1000);
  }
}

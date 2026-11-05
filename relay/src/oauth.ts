import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BOTS_PER_ACCOUNT } from "./app";
import type { Bot, Store } from "./db";
import { clientIp, WindowLimiter } from "./limits";

export interface OAuthOptions {
  store: Store;
  /** Публичный адрес без завершающего слэша, например https://herb.grosst.cc */
  publicUrl: string;
  now?: () => number;
}

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_CODE_FAILURES = 10;
const MAX_REGISTRATIONS = 100;
const MAX_FORM_BYTES = 8 * 1024;
const FORBIDDEN_SCHEMES = new Set(["javascript", "data", "vbscript", "file", "about", "blob", "ftp", "ws", "wss"]);
const COOKIE = "herb_login";
const normalizeCode = (value: string) => value.toUpperCase().replace(/[^0-9A-Z]/g, "");

interface Pending {
  clientId: string;
  redirectUri: string;
  state: string | null;
  challenge: string;
  csrf: string;
  expires: number;
}

interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  botId: string;
  expires: number;
}

const random = () => randomBytes(32).toString("base64url");
const sha256 = (value: string) => createHash("sha256").update(value).digest();
const hashToken = (token: string) => sha256(token).toString("hex");

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
const tokenError = (error: string, status = 400) => json({ error }, status);

function isLoopback(url: URL) {
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

/** https, loopback по http или собственная схема приложения (cursor://, codex://). */
export function isAllowedRedirect(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  const scheme = url.protocol.slice(0, -1);
  if (scheme === "https") return true;
  if (scheme === "http") return isLoopback(url);
  return !FORBIDDEN_SCHEMES.has(scheme);
}

/** Точное совпадение. Для loopback порт может отличаться (RFC 8252). */
function redirectMatches(registered: string[], candidate: string) {
  if (registered.includes(candidate)) return true;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (!isLoopback(url)) return false;
  return registered.some((entry) => {
    const known = new URL(entry);
    return isLoopback(known) && known.hostname === url.hostname && known.pathname === url.pathname && known.search === url.search;
  });
}

function page(title: string, body: string, status = 200, headers: Record<string, string> = {}) {
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f5f4f8;--card:#fff;--text:#1c1a22;--muted:#6b6776;--line:#d9d6e0;--accent:#7c3aed}
@media (prefers-color-scheme:dark){:root{--bg:#141318;--card:#1f1d25;--text:#f2f0f6;--muted:#a5a1b0;--line:#3a3743;--accent:#a78bfa}}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.45 -apple-system,system-ui,sans-serif;padding:16px;box-sizing:border-box}
main{width:100%;max-width:400px;background:var(--card);border-radius:16px;padding:24px;box-sizing:border-box}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted);overflow-wrap:anywhere}
label{display:block;font-size:14px;font-weight:600;margin:0 0 16px}
input{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:12px;font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:10px}
button,a.button{display:block;width:100%;box-sizing:border-box;padding:12px;font:inherit;font-weight:600;text-align:center;text-decoration:none;color:#fff;background:#7c3aed;border:0;border-radius:10px;cursor:pointer}
.error{color:#dc2626}
</style><main>${body}</main></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      ...headers,
    },
  });
}

export function createOAuth(options: OAuthOptions) {
  const { store } = options;
  const now = options.now ?? Date.now;
  const base = new URL(options.publicUrl);
  if (options.publicUrl.endsWith("/") || base.search || base.hash) throw new Error("HERB_PUBLIC_URL must have no trailing slash");
  // На своём домене путь пустой, а не "/".
  const prefix = base.pathname === "/" ? "" : base.pathname;
  const issuer = `${base.origin}${prefix}`;
  const resource = `${issuer}/mcp`;
  const metadataPath = `/.well-known/oauth-protected-resource${prefix}/mcp`;
  const resourceMetadataUrl = `${base.origin}${metadataPath}`;

  const pending = new Map<string, Pending>();
  const codes = new Map<string, Code>();
  // Попытки считаются по адресу: один человек не должен блокировать вход остальным.
  const failures = new WindowLimiter(MAX_CODE_FAILURES, WINDOW_MS);
  let registrations: number[] = [];

  const sweep = () => {
    const t = now();
    for (const [key, value] of pending) if (value.expires < t) pending.delete(key);
    for (const [key, value] of codes) if (value.expires < t) codes.delete(key);
    registrations = registrations.filter((at) => at > t - WINDOW_MS);
  };

  const authServerMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["herb"],
  };
  const resourceMetadata = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: ["herb"],
    bearer_methods_supported: ["header"],
    resource_name: "Herb",
  };

  async function register(request: Request) {
    sweep();
    if (registrations.length >= MAX_REGISTRATIONS) return json({ error: "too_many_requests" }, 429);
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_client_metadata" }, 400);
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 500 && isAllowedRedirect(u))) {
      return json({ error: "invalid_redirect_uri" }, 400);
    }
    registrations.push(now());
    const name = typeof body.client_name === "string" ? body.client_name.trim().slice(0, 60) : "";
    const clientId = randomUUID();
    store.addOAuthClient(clientId, name || "MCP client", uris as string[], now());
    return json({
      client_id: clientId,
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: name || "MCP client",
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, 201);
  }

  const loginForm = (id: string, record: Pending, clientName: string, botName: string, error?: string) => {
    const target = new URL(record.redirectUri);
    return page("Connect to Herb", `<h1>Connect ${escapeHtml(clientName)}?</h1>
<p>It will be able to call your iPhone. After this you return to ${escapeHtml(target.protocol.startsWith("http") ? target.host : target.protocol)}.</p>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${escapeHtml(prefix)}/authorize">
<input type="hidden" name="pending" value="${escapeHtml(id)}"><input type="hidden" name="csrf" value="${escapeHtml(record.csrf)}">
<label>Code from the Herb app<input name="code" required autofocus autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCD-2345"></label>
<label>Agent name<input name="bot_name" value="${escapeHtml(botName)}" maxlength="40" required autocomplete="off"></label>
<button type="submit">Connect</button></form>`, error ? 400 : 200, {
      "set-cookie": `${COOKIE}=${record.csrf}; Path=${prefix}/authorize; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    });
  };

  function startAuthorize(url: URL) {
    sweep();
    const q = url.searchParams;
    const client = store.oauthClient(q.get("client_id") ?? "");
    const redirectUri = q.get("redirect_uri") ?? "";
    // Без проверенного клиента и адреса возврата перенаправлять нельзя.
    if (!client || !redirectMatches(client.redirect_uris, redirectUri)) {
      return page("Error", "<h1>Unknown client</h1><p>Start connecting again from your agent.</p>", 400);
    }
    const challenge = q.get("code_challenge") ?? "";
    const requested = q.get("resource");
    if (
      q.get("response_type") !== "code" ||
      q.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) ||
      (requested !== null && requested !== resource)
    ) {
      const back = new URL(redirectUri);
      back.searchParams.set("error", "invalid_request");
      const state = q.get("state");
      if (state) back.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: back.href, "cache-control": "no-store" } });
    }
    const id = random();
    const record: Pending = {
      clientId: client.id,
      redirectUri,
      state: q.get("state"),
      challenge,
      csrf: random(),
      expires: now() + PENDING_TTL_MS,
    };
    pending.set(id, record);
    return loginForm(id, record, client.name, client.name);
  }

  async function approve(request: Request) {
    sweep();
    if (request.headers.get("origin") !== base.origin) return page("Error", "<h1>Request refused</h1><p>Start connecting again from your agent.</p>", 403);
    if (Number(request.headers.get("content-length") ?? 0) > MAX_FORM_BYTES) return page("Error", "<h1>Request is too large</h1>", 413);
    const form = new URLSearchParams(await request.text());
    const id = form.get("pending") ?? "";
    const record = pending.get(id);
    const cookie = (request.headers.get("cookie") ?? "").split(";").map((v) => v.trim()).find((v) => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const csrf = form.get("csrf") ?? "";
    if (!record || !cookie || cookie !== record.csrf || csrf !== record.csrf) {
      return page("Sign-in expired", "<h1>Sign-in expired</h1><p>Start connecting again from your agent.</p>", 400);
    }
    const client = store.oauthClient(record.clientId);
    if (!client) return page("Error", "<h1>Unknown client</h1>", 400);

    const botName = (form.get("bot_name") ?? "").trim();
    const ip = clientIp(request);
    if (failures.exceeded(ip, now())) {
      return page("Too many attempts", "<h1>Too many attempts</h1><p>Wait 15 minutes, then start again from your agent.</p>", 429);
    }
    if (!botName || botName.length > 40) return loginForm(id, record, client.name, client.name, "Enter an agent name, up to 40 characters");
    const deviceId = store.consumeConnectCode(normalizeCode(form.get("code") ?? ""), now());
    if (!deviceId) {
      failures.record(ip, now());
      return loginForm(id, record, client.name, botName, "Wrong or expired code. Get a new one in the Herb app");
    }

    pending.delete(id);
    let bot = store.botByName(deviceId, botName);
    if (!bot) {
      if (store.countBots(deviceId) >= BOTS_PER_ACCOUNT) {
        return page("Too many agents", `<h1>Too many agents</h1><p>Remove one in the Herb app. The limit is ${BOTS_PER_ACCOUNT}.</p>`, 403);
      }
      bot = store.bot(store.addBot({ deviceId, name: botName }).id)!;
    }
    const code = random();
    codes.set(code, {
      clientId: record.clientId,
      redirectUri: record.redirectUri,
      challenge: record.challenge,
      botId: bot.id,
      expires: now() + CODE_TTL_MS,
    });
    const back = new URL(record.redirectUri);
    back.searchParams.set("code", code);
    if (record.state) back.searchParams.set("state", record.state);
    // Браузер может заблокировать переход на чужую схему после формы, поэтому есть и ссылка.
    const href = escapeHtml(back.href);
    return page("Connected", `<h1>Connected</h1><p>${escapeHtml(client.name)} can now call you as ${escapeHtml(bot.name)}. You can return to your agent.</p><a class="button" href="${href}">Continue</a>`, 200, {
      refresh: `0;url=${back.href}`,
      "set-cookie": `${COOKIE}=; Path=${prefix}/authorize; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    });
  }

  function issue(grantId: string | null, clientId: string, botId: string, previousRefresh?: string) {
    const access = `herb_oat_${random()}`;
    const refresh = `herb_ort_${random()}`;
    const values = {
      accessHash: hashToken(access),
      accessExpires: now() + ACCESS_TTL_MS,
      refreshHash: hashToken(refresh),
      refreshExpires: now() + REFRESH_TTL_MS,
    };
    if (grantId) store.rotateOAuthGrant(grantId, { ...values, previousRefreshHash: previousRefresh! });
    else store.addOAuthGrant({ id: randomUUID(), clientId, botId, ...values });
    return json({
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refresh,
      scope: "herb",
    });
  }

  async function token(request: Request) {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_FORM_BYTES) return tokenError("invalid_request", 413);
    const form = new URLSearchParams(await request.text());
    const clientId = form.get("client_id") ?? "";
    if (!store.oauthClient(clientId)) return tokenError("invalid_client", 401);
    const requested = form.get("resource");
    if (requested !== null && requested !== resource) return tokenError("invalid_target");

    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      const value = form.get("code") ?? "";
      const code = codes.get(value);
      // Код одноразовый: удаляется при любой попытке.
      codes.delete(value);
      if (!code || code.expires < now() || code.clientId !== clientId || code.redirectUri !== form.get("redirect_uri")) {
        return tokenError("invalid_grant");
      }
      const computed = Buffer.from(sha256(form.get("code_verifier") ?? "").toString("base64url"));
      const expected = Buffer.from(code.challenge);
      if (computed.length !== expected.length || !timingSafeEqual(computed, expected)) return tokenError("invalid_grant");
      return issue(null, clientId, code.botId);
    }
    if (grantType === "refresh_token") {
      const hash = hashToken(form.get("refresh_token") ?? "");
      const reused = store.oauthGrantByPreviousRefresh(hash);
      if (reused) {
        // Старый токен предъявили повторно: возможна кража, отзываем весь доступ клиента.
        store.deleteOAuthGrant(reused.id);
        return tokenError("invalid_grant");
      }
      const grant = store.oauthGrantByRefresh(hash);
      if (!grant || grant.client_id !== clientId || grant.refresh_expires < now()) return tokenError("invalid_grant");
      return issue(grant.id, clientId, grant.bot_id, hash);
    }
    return tokenError("unsupported_grant_type");
  }

  async function revoke(request: Request) {
    const form = new URLSearchParams(await request.text());
    store.deleteOAuthGrantByToken(hashToken(form.get("token") ?? ""));
    return new Response(null, { status: 200, headers: NO_STORE });
  }

  /** Возвращает null, если путь не относится к OAuth. */
  async function handle(request: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    const method = request.method;
    if (path.startsWith("/.well-known/oauth-authorization-server") && method === "GET") return json(authServerMetadata);
    if (path.startsWith("/.well-known/openid-configuration") && method === "GET") return json(authServerMetadata);
    if (path.startsWith("/.well-known/oauth-protected-resource") && method === "GET") return json(resourceMetadata);
    if (path === "/register" && method === "POST") return register(request);
    if (path === "/authorize" && method === "GET") return startAuthorize(url);
    if (path === "/authorize" && method === "POST") return approve(request);
    if (path === "/token" && method === "POST") return token(request);
    if (path === "/revoke" && method === "POST") return revoke(request);
    return null;
  }

  function botByAccessToken(value: string): Bot | null {
    return store.botByOAuthAccess(hashToken(value), now());
  }

  /** Подсказка клиенту, где начинается вход. */
  const challengeHeader = `Bearer resource_metadata="${resourceMetadataUrl}"`;

  return { handle, botByAccessToken, challengeHeader };
}

export type OAuth = ReturnType<typeof createOAuth>;

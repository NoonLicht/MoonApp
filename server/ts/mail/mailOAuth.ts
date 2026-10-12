/**
 * Вход через аккаунт (OAuth 2.0, PKCE + loopback) для Gmail и Outlook/Microsoft 365.
 *
 * Идентификатор клиента (и секрет для Google «Desktop app») пользователь создаёт сам
 * в консоли провайдера и вносит в настройки почты — своих ключей в приложение мы не
 * зашиваем. Токены хранятся зашифрованными (safeStorage/AES), доступ обновляется сам.
 */
import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";
import { encryptSecret, decryptSecret } from "../security";
import { getSettings } from "./mailSettings";

export type OAuthProvider = "google" | "microsoft";

export interface OAuthTokens {
  provider: OAuthProvider;
  access: string;
  refresh: string;
  expires: number;
}

interface ProviderCfg {
  auth: string;
  token: string;
  scope: string;
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
}

const CFG: Record<OAuthProvider, ProviderCfg> = {
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "https://mail.google.com/ openid email profile",
    imap: { host: "imap.gmail.com", port: 993 },
    smtp: { host: "smtp.gmail.com", port: 465 },
  },
  microsoft: {
    auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope:
      "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile",
    imap: { host: "outlook.office365.com", port: 993 },
    smtp: { host: "smtp.office365.com", port: 587 },
  },
};

export function oauthServers(p: OAuthProvider): ProviderCfg {
  return CFG[p];
}

function clientCreds(p: OAuthProvider): { id: string; secret: string } {
  const o = getSettings().oauth;
  if (p === "google") return { id: o.googleClientId, secret: o.googleClientSecret };
  return { id: o.microsoftClientId, secret: "" };
}

export function oauthConfigured(p: OAuthProvider): boolean {
  return !!clientCreds(p).id;
}

const b64u = (b: Buffer) => b.toString("base64url");

export interface OAuthSession {
  id: string;
  provider: OAuthProvider;
  status: "pending" | "done" | "error";
  email?: string;
  error?: string;
  accountId?: string;
}

const sessions = new Map<string, OAuthSession>();

export function oauthStatus(id: string): OAuthSession | null {
  return sessions.get(id) ?? null;
}

function parseJwt(t: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(t.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

async function tokenRequest(p: OAuthProvider, body: Record<string, string>): Promise<Record<string, unknown>> {
  const { id, secret } = clientCreds(p);
  const form = new URLSearchParams({ client_id: id, ...body });
  if (secret) form.set("client_secret", secret);
  const res = await fetch(CFG[p].token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(j.error_description || j.error || `HTTP ${res.status}`));
  return j;
}

/**
 * Запускает вход: поднимает loopback-сервер, возвращает адрес страницы авторизации.
 * После успеха вызывается finish(email, name, tokens) — там создаётся ящик.
 */
export async function oauthStart(
  provider: OAuthProvider,
  finish: (info: { email: string; name: string; tokens: OAuthTokens }) => Promise<string>,
): Promise<{ id: string; url: string }> {
  const cfg = CFG[provider];
  const { id: clientId } = clientCreds(provider);
  if (!clientId) throw new Error("oauth_not_configured");
  const sid = crypto.randomUUID();
  const verifier = b64u(crypto.randomBytes(48));
  const challenge = b64u(crypto.createHash("sha256").update(verifier).digest());
  const state = b64u(crypto.randomBytes(16));
  const sess: OAuthSession = { id: sid, provider, status: "pending" };
  sessions.set(sid, sess);

  const server = http.createServer();
  const closeLater = () => setTimeout(() => server.close(), 500).unref();
  const timeout = setTimeout(() => {
    if (sess.status === "pending") {
      sess.status = "error";
      sess.error = "timeout";
    }
    server.close();
  }, 5 * 60_000);
  timeout.unref();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const redirect = `http://127.0.0.1:${port}/cb`;

  server.on("request", async (req, res) => {
    const u = new URL(req.url || "/", redirect);
    if (u.pathname !== "/cb") {
      res.writeHead(404).end();
      return;
    }
    const page = (msg: string) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><title>MoonApp</title><body style="font-family:system-ui;padding:40px;text-align:center"><h2>${msg}</h2><p>Можно закрыть эту вкладку и вернуться в приложение.</p>`);
    };
    try {
      if (u.searchParams.get("state") !== state) throw new Error("state_mismatch");
      const err = u.searchParams.get("error");
      if (err) throw new Error(err);
      const code = u.searchParams.get("code");
      if (!code) throw new Error("no_code");
      const j = await tokenRequest(provider, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
      });
      const claims = parseJwt(String(j.id_token || ""));
      const email = String(claims.email || claims.preferred_username || "");
      if (!email) throw new Error("no_email");
      const tokens: OAuthTokens = {
        provider,
        access: String(j.access_token),
        refresh: String(j.refresh_token || ""),
        expires: Date.now() + Number(j.expires_in || 3600) * 1000,
      };
      sess.accountId = await finish({ email, name: String(claims.name || email), tokens });
      sess.email = email;
      sess.status = "done";
      page("Ящик подключён");
    } catch (e) {
      sess.status = "error";
      sess.error = (e as Error).message;
      page("Не удалось войти: " + (e as Error).message);
    } finally {
      clearTimeout(timeout);
      closeLater();
    }
  });

  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: cfg.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (provider === "google") {
    q.set("access_type", "offline");
    q.set("prompt", "consent");
  } else q.set("prompt", "select_account");
  return { id: sid, url: `${cfg.auth}?${q.toString()}` };
}

export function packTokens(t: OAuthTokens): string {
  return encryptSecret(JSON.stringify(t));
}

export function unpackTokens(enc: string): OAuthTokens {
  return JSON.parse(decryptSecret(enc)) as OAuthTokens;
}

/** Возвращает действующий access-токен; при необходимости обновляет и сообщает новое хранимое значение. */
export async function freshAccessToken(
  enc: string,
  save: (newEnc: string) => void,
): Promise<string> {
  const t = unpackTokens(enc);
  if (t.expires - 60_000 > Date.now()) return t.access;
  if (!t.refresh) throw new Error("oauth_expired");
  const j = await tokenRequest(t.provider, { grant_type: "refresh_token", refresh_token: t.refresh });
  const next: OAuthTokens = {
    provider: t.provider,
    access: String(j.access_token),
    refresh: String(j.refresh_token || t.refresh),
    expires: Date.now() + Number(j.expires_in || 3600) * 1000,
  };
  save(packTokens(next));
  return next.access;
}

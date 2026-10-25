import type { Env } from "./env";

const COOKIE_NAME = "__Host-lt";
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function safeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  return safeEqualBytes(enc.encode(a), enc.encode(b));
}

export async function signSessionValue(
  secret: string,
  nowSeconds: number,
): Promise<string> {
  const exp = nowSeconds + MAX_AGE_SECONDS;
  const sig = await hmac(secret, `lt.${exp}`);
  return `${exp}.${sig}`;
}

export function sessionCookieHeader(value: string): string {
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearSessionCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}

export async function verifySession(
  cookieHeader: string | null,
  secret: string,
  nowSeconds: number,
): Promise<boolean> {
  if (!cookieHeader) return false;
  const raw = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return false;
  const value = raw.slice(COOKIE_NAME.length + 1);
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(value.slice(0, dot));
  if (!Number.isFinite(exp) || exp <= nowSeconds) return false;
  const expected = await hmac(secret, `lt.${exp}`);
  return safeEqualBytes(enc.encode(value.slice(dot + 1)), enc.encode(expected));
}

export async function checkPassword(
  candidate: string,
  secret: string,
): Promise<boolean> {
  if (!candidate || !secret) return false;
  return safeEqual(candidate, secret);
}

// Cross-site POSTs carry a different origin (or none); allow absent Origin so
// non-browser clients still work, reject mismatching ones.
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

const LOGIN_FAIL_PREFIX = "login-fail:";
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_BLOCK_SECONDS = 15 * 60;

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

export async function loginBlocked(
  env: Env,
  ip: string,
): Promise<boolean> {
  const v = await env.OAUTH_KV.get(LOGIN_FAIL_PREFIX + ip);
  return v !== null && Number(v) >= LOGIN_FAIL_LIMIT;
}

export async function recordLoginFailure(
  env: Env,
  ip: string,
): Promise<void> {
  const key = LOGIN_FAIL_PREFIX + ip;
  const fails = Number(await env.OAUTH_KV.get(key)) + 1;
  await env.OAUTH_KV.put(key, String(fails), {
    expirationTtl: LOGIN_BLOCK_SECONDS,
  });
}

export async function clearLoginFailures(
  env: Env,
  ip: string,
): Promise<void> {
  await env.OAUTH_KV.delete(LOGIN_FAIL_PREFIX + ip);
}

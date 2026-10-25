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

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ADMIN_PASSWORD: string;
  OWTRACKS_USER: string;
  OWTRACKS_PASSWORD: string;
  HISTORY_SIZE?: string;
  PUBLIC_BASE_URL?: string;
}

export function historySize(env: Env): number {
  const n = Number(env.HISTORY_SIZE ?? "10");
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? Math.floor(n) : 10;
}

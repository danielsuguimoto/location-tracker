import {
  OAuthProvider,
  getOAuthApi,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";

type SecretMethod = "client_secret_basic" | "client_secret_post";

function isSecretMethod(value: unknown): value is SecretMethod {
  return value === "client_secret_basic" || value === "client_secret_post";
}

function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

async function normalizeClientAuthentication(
  request: Request,
  oauth: OAuthHelpers,
): Promise<Request> {
  const contentType = request.headers.get("Content-Type")
    ?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return request;
  const params = new URLSearchParams(await request.clone().text());
  if (!["authorization_code", "refresh_token"].includes(params.get("grant_type") ?? "")) {
    return request;
  }
  // Let the provider reject ambiguous authentication; never repair conflicting credentials.
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (key !== "resource" && seen.has(key)) return request;
    seen.add(key);
  }
  if (params.has("client_assertion") || params.has("client_assertion_type")) {
    return request;
  }

  const authorization = request.headers.get("Authorization");
  let presented: SecretMethod;
  let clientId: string;
  let secret: string;
  if (authorization) {
    if (params.has("client_secret")) return request;
    const basic = /^Basic[ \t]+([^ \t]+)$/i.exec(authorization);
    if (!basic) return request;
    try {
      const decoded = atob(basic[1]!);
      const colon = decoded.indexOf(":");
      if (colon < 0) return request;
      clientId = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " "));
      secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " "));
    } catch {
      return request;
    }
    if (params.has("client_id") && params.get("client_id") !== clientId) return request;
    presented = "client_secret_basic";
  } else {
    clientId = params.get("client_id") ?? "";
    secret = params.get("client_secret") ?? "";
    presented = "client_secret_post";
  }
  if (!clientId || !secret) return request;
  const client = await oauth.lookupClient(clientId);
  const registered = client?.tokenEndpointAuthMethod;
  if (!isSecretMethod(registered) || registered === presented) return request;

  // Only change the secret's transport. The provider still authenticates it and validates the grant.
  const headers = new Headers(request.headers);
  if (registered === "client_secret_basic") {
    const encoded = btoa(`${formEncode(clientId)}:${formEncode(secret)}`);
    headers.set("Authorization", `Basic ${encoded}`);
    params.delete("client_id");
    params.delete("client_secret");
  } else {
    headers.delete("Authorization");
    params.set("client_id", clientId);
    params.set("client_secret", secret);
  }
  headers.delete("Content-Length");
  return new Request(request, { headers, body: params });
}

const logOAuthError: NonNullable<OAuthProviderOptions<Env>["onError"]> = ({
  code, status, internal,
}) => {
  const detail = internal.detail as Record<string, unknown> | undefined;
  console.warn("OAuth request rejected", {
    code,
    status,
    category: internal.category,
    reason: internal.reason,
    ...(detail && (isSecretMethod(detail.registeredMethod) || detail.registeredMethod === "none")
      ? { registeredMethod: detail.registeredMethod }
      : {}),
    ...(detail && (isSecretMethod(detail.presentedMethod) || detail.presentedMethod === "none")
      ? { presentedMethod: detail.presentedMethod }
      : {}),
  });
};

export async function fetchOAuth(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  options: OAuthProviderOptions<Env>,
): Promise<Response> {
  const provider = new OAuthProvider({
    ...options,
    onError: options.onError ?? logOAuthError,
  });
  const url = new URL(request.url);
  const tokenUrl = new URL(options.tokenEndpoint, url);
  const isTokenRequest = request.method === "POST" &&
    url.origin === tokenUrl.origin && url.pathname === tokenUrl.pathname;
  const normalized = isTokenRequest
    ? await normalizeClientAuthentication(request, getOAuthApi(options, env))
    : request;
  const response = await provider.fetch(normalized, env, ctx);
  if (normalized !== request && response.status === 401 &&
    /^Basic[ \t]/i.test(request.headers.get("Authorization") ?? "")) {
    response.headers.set("WWW-Authenticate", 'Basic realm="oauth"');
  }
  return response;
}

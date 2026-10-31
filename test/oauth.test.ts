import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { fetchOAuth } from "../src/oauth";
import { handleAuthorize } from "../src/admin/consent";
import { signSessionValue } from "../src/session";
import type { Env } from "../src/env";
import { DEFAULT_SCOPES } from "../src/scopes";
import { FakeD1, makeCtx, makeEnv } from "./helpers";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const ORIGIN = "https://worker.example";
const REDIRECT = "https://client.example/callback";
const VERIFIER = "a".repeat(43);
type Method = "client_secret_basic" | "client_secret_post" | "none";
type Client = { client_id: string; client_secret?: string };
type Tokens = { access_token: string; refresh_token: string; scope: string; resource: string };

function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

describe("OAuth client authentication and refresh", () => {
  let env: Env;
  let options: OAuthProviderOptions<Env>;
  let cookie: string;
  let warnings: ReturnType<typeof vi.spyOn>;

  async function fetch(path: string | URL, init?: RequestInit, raw = false) {
    const request = new Request(new URL(path, ORIGIN), init);
    return raw
      ? new OAuthProvider(options).fetch(request, env, makeCtx())
      : fetchOAuth(request, env, makeCtx(), options);
  }

  async function register(method?: Method): Promise<Client> {
    const response = await fetch("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test MCP client",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: method,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(response.status).toBe(201);
    const client = await response.json() as Client & { token_endpoint_auth_method: string };
    expect(client.token_endpoint_auth_method).toBe(method ?? "client_secret_basic");
    if (method === "none") expect(client.client_secret).toBeUndefined();
    else expect(client.client_secret).toBeTruthy();
    return client;
  }

  function credentials(client: Client, method: Method, fields: Record<string, string>) {
    const body = new URLSearchParams(fields);
    const headers = new Headers();
    if (method === "client_secret_basic") {
      headers.set("Authorization", `Basic ${btoa(`${formEncode(client.client_id)}:${formEncode(client.client_secret ?? "")}`)}`);
    } else {
      body.set("client_id", client.client_id);
      if (method === "client_secret_post" && client.client_secret !== undefined) {
        body.set("client_secret", client.client_secret);
      }
    }
    return { method: "POST", headers, body };
  }

  async function authorize(client: Client): Promise<string> {
    const challenge = Buffer.from(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(VERIFIER),
    )).toString("base64url");
    const url = new URL("/authorize", ORIGIN);
    url.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "test-state",
    }).toString();
    const page = await fetch(url, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)![1]!;
    const body = new URLSearchParams({ handle, decision: "approve" });
    for (const scope of DEFAULT_SCOPES) body.append("scope", scope);
    const response = await fetch("/authorize", {
      method: "POST",
      headers: { Cookie: `${cookie}; ${page.headers.getSetCookie()[0]!.split(";")[0]}`, Origin: ORIGIN },
      body,
    });
    expect(response.status).toBe(302);
    return new URL(response.headers.get("Location")!).searchParams.get("code")!;
  }

  async function exchange(client: Client, method: Method): Promise<Tokens> {
    const code = await authorize(client);
    const response = await fetch("/oauth/token", credentials(client, method, {
      grant_type: "authorization_code", code, code_verifier: VERIFIER, redirect_uri: REDIRECT,
    }));
    expect(response.status).toBe(200);
    return response.json() as Promise<Tokens>;
  }

  function refresh(client: Client, method: Method, token: string, raw = false) {
    return fetch("/oauth/token", credentials(client, method, {
      grant_type: "refresh_token", refresh_token: token,
    }), raw);
  }

  beforeEach(async () => {
    warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const values = new Map<string, { value: string; expires?: number }>();
    env = makeEnv(new FakeD1());
    Reflect.deleteProperty(env, "OAUTH_PROVIDER");
    env.OAUTH_KV = {
      async get(key: string, options?: string | { type?: string }) {
        const entry = values.get(key);
        if (!entry || (entry.expires !== undefined && entry.expires <= Date.now() / 1000)) return null;
        const type = typeof options === "string" ? options : options?.type;
        return type === "json" ? JSON.parse(entry.value) : entry.value;
      },
      async put(key: string, value: string, options?: { expirationTtl?: number }) {
        values.set(key, { value, expires: options?.expirationTtl === undefined ? undefined : Date.now() / 1000 + options.expirationTtl });
      },
      async delete(key: string) { values.delete(key); },
      async list({ prefix }: { prefix: string }) {
        return { keys: [...values.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
      },
    } as unknown as KVNamespace;
    options = {
      apiRoute: "/mcp",
      apiHandler: { fetch: (_req, _env, ctx) => Response.json(ctx.props) },
      defaultHandler: { fetch: (req, bindings) => handleAuthorize(req, bindings) },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: DEFAULT_SCOPES,
      resourceMetadata: { resource: `${ORIGIN}/mcp` },
    };
    cookie = `__Host-lt=${await signSessionValue(env.ADMIN_PASSWORD, Math.floor(Date.now() / 1000))}`;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("keeps discovery and implicit-registration defaults interoperable", async () => {
    const response = await fetch("/.well-known/oauth-authorization-server");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    });
    const client = await register();
    const tokens = await exchange(client, "client_secret_basic");
    expect((await refresh(client, "client_secret_post", tokens.refresh_token)).status).toBe(200);
  });

  it.each([
    ["client_secret_basic", "client_secret_post"],
    ["client_secret_post", "client_secret_basic"],
  ] as const)("reproduces the production error for %s -> %s without compatibility", async (registered, presented) => {
    const client = await register(registered);
    const tokens = await exchange(client, registered);
    const response = await refresh(client, presented, tokens.refresh_token, true);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_client", error_description: "Client authentication failed" });
  });

  it.each([
    ["client_secret_basic", "client_secret_post"],
    ["client_secret_post", "client_secret_basic"],
    ["client_secret_basic", "client_secret_basic"],
    ["client_secret_post", "client_secret_post"],
    ["none", "none"],
  ] as const)("refreshes and preserves the grant for %s -> %s after access-token expiry", async (registered, presented) => {
    const client = await register(registered);
    const tokens = await exchange(client, registered);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3601 * 1000);
    expect((await fetch("/mcp", { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
    const response = await refresh(client, presented, tokens.refresh_token);
    expect(response.status).toBe(200);
    const rotated = await response.json() as Tokens;
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect(rotated.scope).toBe(DEFAULT_SCOPES.join(" "));
    expect(rotated.resource).toBe(`${ORIGIN}/mcp`);
    const resource = await fetch("/mcp", { headers: { Authorization: `Bearer ${rotated.access_token}` } });
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({ userId: "jun", clientId: client.client_id, scope: DEFAULT_SCOPES });
    expect((await refresh(client, presented, rotated.refresh_token)).status).toBe(200);
    const replay = await refresh(client, presented, tokens.refresh_token);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  it.each([
    ["client_secret_basic", "client_secret_post"],
    ["client_secret_post", "client_secret_basic"],
  ] as const)("also normalizes the code exchange for %s -> %s", async (registered, presented) => {
    const client = await register(registered);
    const tokens = await exchange(client, presented);
    expect((await refresh(client, presented, tokens.refresh_token)).status).toBe(200);
  });

  it.each([
    ["client_secret_basic", "client_secret_post"],
    ["client_secret_post", "client_secret_basic"],
  ] as const)("still verifies the secret for %s -> %s", async (registered, presented) => {
    const client = await register(registered);
    const tokens = await exchange(client, registered);
    const response = await refresh({ ...client, client_secret: "wrong-secret" }, presented, tokens.refresh_token);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
    if (presented === "client_secret_basic") {
      expect(response.headers.get("WWW-Authenticate")).toMatch(/^Basic /);
    }
    expect((await refresh(client, presented, tokens.refresh_token)).status).toBe(200);
  });

  it.each(["client_secret_basic", "client_secret_post"] as const)("never downgrades %s to a public client", async (registered) => {
    const client = await register(registered);
    const tokens = await exchange(client, registered);
    for (const presented of ["none", "client_secret_basic", "client_secret_post"] as const) {
      const response = await refresh({ client_id: client.client_id }, presented, tokens.refresh_token);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "invalid_client" });
    }
    expect((await refresh(client, registered, tokens.refresh_token)).status).toBe(200);
  });

  it.each(["client_secret_basic", "client_secret_post"] as const)("never converts a public client to %s", async (presented) => {
    const client = await register("none");
    const tokens = await exchange(client, "none");
    warnings.mockClear();
    const response = await refresh({ ...client, client_secret: "unregistered-secret" }, presented, tokens.refresh_token);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_client", error_description: "Client authentication failed" });
    expect(warnings).toHaveBeenCalledWith("OAuth request rejected", expect.objectContaining({
      reason: "token_endpoint_auth_method_mismatch", registeredMethod: "none", presentedMethod: presented,
    }));
    const logs = JSON.stringify(warnings.mock.calls);
    for (const value of [client.client_id, "unregistered-secret", tokens.refresh_token, tokens.access_token]) {
      expect(logs).not.toContain(value);
    }
    expect((await refresh(client, "none", tokens.refresh_token)).status).toBe(200);
  });

  it("requires PKCE for public clients", async () => {
    const client = await register("none");
    const url = new URL("/authorize", ORIGIN);
    url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT, response_type: "code" }).toString();
    const response = await fetch(url, { headers: { Cookie: cookie } });
    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get("Location")!);
    expect(redirect.searchParams.get("error")).toBe("invalid_request");
    expect(redirect.searchParams.has("code")).toBe(false);
  });

  it("does not bypass PKCE during a normalized code exchange", async () => {
    const client = await register("client_secret_post");
    const code = await authorize(client);
    const response = await fetch("/oauth/token", credentials(client, "client_secret_basic", {
      grant_type: "authorization_code", code, code_verifier: "b".repeat(43), redirect_uri: REDIRECT,
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects refresh tokens belonging to a different client", async () => {
    const owner = await register("client_secret_basic");
    const other = await register("client_secret_post");
    const tokens = await exchange(owner, "client_secret_basic");
    const response = await refresh(other, "client_secret_basic", tokens.refresh_token);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect((await refresh(owner, "client_secret_post", tokens.refresh_token)).status).toBe(200);
  });

  it("does not revive expired grants", async () => {
    const client = await register("client_secret_post");
    const tokens = await exchange(client, "client_secret_post");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31 * 86400 * 1000);
    const response = await refresh(client, "client_secret_basic", tokens.refresh_token);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("does not revive revoked grants", async () => {
    const client = await register("client_secret_post");
    const tokens = await exchange(client, "client_secret_post");
    const revoked = await fetch("/oauth/token", credentials(client, "client_secret_post", { token: tokens.refresh_token }));
    expect(revoked.status).toBe(200);
    const response = await refresh(client, "client_secret_basic", tokens.refresh_token);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("leaves unknown clients rejected and does not create a registration", async () => {
    const put = vi.spyOn(env.OAUTH_KV, "put");
    const response = await refresh({ client_id: "unknown", client_secret: "unknown-secret" }, "client_secret_basic", "not-a-token");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
    expect(put).not.toHaveBeenCalled();
  });

  it.each(["client_id", "client_secret", "grant_type"])("does not repair repeated %s parameters", async (parameter) => {
    const client = await register("client_secret_basic");
    const tokens = await exchange(client, "client_secret_basic");
    const init = credentials(client, "client_secret_post", { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    init.body.append(parameter, init.body.get(parameter)!);
    const response = await fetch("/oauth/token", init);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it.each(["basic-and-body", "assertion-and-secret"])("does not repair mixed authentication: %s", async (kind) => {
    const client = await register("client_secret_post");
    const tokens = await exchange(client, "client_secret_post");
    const init = credentials(client, "client_secret_post", { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    if (kind === "basic-and-body") {
      init.headers.set("Authorization", credentials(client, "client_secret_basic", {}).headers.get("Authorization")!);
    } else {
      init.body.set("client_assertion", "untrusted-assertion");
      init.body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    }
    const response = await fetch("/oauth/token", init);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it.each([true, false])("checks body client_id against Basic identity (matching: %s)", async (matching) => {
    const client = await register("client_secret_post");
    const tokens = await exchange(client, "client_secret_post");
    const init = credentials(client, "client_secret_basic", {
      grant_type: "refresh_token", refresh_token: tokens.refresh_token,
      client_id: matching ? client.client_id : "another-client",
    });
    const response = await fetch("/oauth/token", init);
    expect(response.status).toBe(matching ? 200 : 400);
    if (!matching) expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it.each(["Basic %%%", `Basic ${btoa("no-colon")}`, `Basic ${btoa("%GG:secret")}`])("leaves malformed Basic authentication rejected (%s)", async (authorization) => {
    const response = await fetch("/oauth/token", {
      method: "POST", headers: { Authorization: authorization },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "invalid" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });

  it.each(["application/json", "text/plain"])("does not accept %s token requests", async (contentType) => {
    const client = await register("client_secret_basic");
    const init = credentials(client, "client_secret_post", { grant_type: "refresh_token", refresh_token: "invalid" });
    init.headers.set("Content-Type", contentType);
    const response = await fetch("/oauth/token", init);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("preserves resource binding and scope ceilings without rewriting client records", async () => {
    const client = await register("client_secret_basic");
    const tokens = await exchange(client, "client_secret_basic");
    const put = vi.spyOn(env.OAUTH_KV, "put");
    const fields = { grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: "https://other.example/mcp" };
    const wrongResource = await fetch("/oauth/token", credentials(client, "client_secret_post", fields));
    expect(wrongResource.status).toBe(400);
    expect(await wrongResource.json()).toMatchObject({ error: "invalid_target" });
    const init = credentials(client, "client_secret_post", { ...fields, resource: `${ORIGIN}/mcp` });
    init.body.append("resource", "https://other.example/mcp");
    const multipleResources = await fetch("/oauth/token", init);
    expect(multipleResources.status).toBe(400);
    expect(await multipleResources.json()).toMatchObject({ error: "invalid_target" });
    const response = await fetch("/oauth/token", credentials(client, "client_secret_post", {
      grant_type: "refresh_token", refresh_token: tokens.refresh_token, scope: "location:read admin:all",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scope: "location:read" });
    expect(put.mock.calls.some(([key]) => key.startsWith("client:"))).toBe(false);
  });
});

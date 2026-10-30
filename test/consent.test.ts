import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { handleAuthorize } from "../src/admin/consent";
import { signSessionValue } from "../src/session";
import type { Env } from "../src/env";
import { FakeD1, makeCtx, makeEnv } from "./helpers";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const ORIGIN = "https://worker.example";
const DEFAULT_SCOPES = ["location:read", "geofence:write"];
const VERIFIER = "a".repeat(43);

describe("OAuth consent scopes", () => {
  let env: Env;
  let provider: OAuthProvider<Env>;
  let cookie: string;
  let authorizeUrl: URL;
  let parsedScope: null | undefined;
  let overrideParsedScope: boolean;

  async function fetch(path: string | URL, init?: RequestInit) {
    return provider.fetch(
      new Request(new URL(path, ORIGIN), init),
      env,
      makeCtx(),
    );
  }

  async function consentPage() {
    const response = await fetch(authorizeUrl, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
    expect(handle).toBeTruthy();
    const binding = response.headers.getSetCookie()[0]!.split(";")[0];
    return { html, handle: handle!, cookie: `${cookie}; ${binding}` };
  }

  async function approve(scopes: string[]) {
    const page = await consentPage();
    const body = new URLSearchParams({ handle: page.handle, decision: "approve" });
    for (const scope of scopes) body.append("scope", scope);
    const response = await fetch("/authorize", {
      method: "POST",
      headers: { Cookie: page.cookie, Origin: ORIGIN },
      body,
    });
    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get("Location")!);
    expect(redirect.searchParams.has("error")).toBe(false);
    expect(redirect.searchParams.get("code")).toBeTruthy();
    return { response, code: redirect.searchParams.get("code")! };
  }

  async function tokenScopes(code: string) {
    const response = await fetch("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: authorizeUrl.searchParams.get("client_id")!,
        redirect_uri: "https://client.example/callback",
        code,
        code_verifier: VERIFIER,
      }),
    });
    expect(response.status).toBe(200);
    const token = (await response.json()) as { scope: string };
    return token.scope.split(" ").filter(Boolean);
  }

  beforeEach(async () => {
    const values = new Map<string, string>();
    env = makeEnv(new FakeD1());
    Reflect.deleteProperty(env, "OAUTH_PROVIDER");
    env.OAUTH_KV = {
      async get(key: string, options?: string | { type?: string }) {
        const value = values.get(key) ?? null;
        const type = typeof options === "string" ? options : options?.type;
        return value !== null && type === "json" ? JSON.parse(value) : value;
      },
      async put(key: string, value: string) {
        values.set(key, value);
      },
      async delete(key: string) {
        values.delete(key);
      },
      async list({ prefix }: { prefix: string }) {
        return {
          keys: [...values.keys()]
            .filter((name) => name.startsWith(prefix))
            .map((name) => ({ name })),
          list_complete: true,
        };
      },
    } as unknown as KVNamespace;
    overrideParsedScope = false;
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: { fetch: () => new Response("ok") },
      defaultHandler: {
        fetch: async (request, bindings) => {
          if (overrideParsedScope && request.method === "GET") {
            const authRequest = await bindings.OAUTH_PROVIDER.parseAuthRequest(
              request,
            );
            vi.spyOn(bindings.OAUTH_PROVIDER, "parseAuthRequest")
              .mockResolvedValue({
                ...authRequest,
                scope: parsedScope as unknown as string[],
              });
          }
          return handleAuthorize(request, bindings);
        },
      },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: DEFAULT_SCOPES,
      resourceMetadata: { resource: `${ORIGIN}/mcp` },
    });
    const registration = await fetch("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Poke",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    });
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };
    const challenge = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER)),
    ).toString("base64url");
    authorizeUrl = new URL("/authorize", ORIGIN);
    authorizeUrl.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://client.example/callback",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "test-state",
    }).toString();
    const value = await signSessionValue(
      env.ADMIN_PASSWORD,
      Math.floor(Date.now() / 1000),
    );
    cookie = `__Host-lt=${value}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([undefined, "", "   "])(
    "checks and grants defaults for scope=%j",
    async (scope) => {
      if (scope !== undefined) authorizeUrl.searchParams.set("scope", scope);
      const page = await consentPage();
      for (const value of DEFAULT_SCOPES) {
        expect(page.html).toContain(`name="scope" value="${value}" checked`);
      }
      const { code } = await approve(DEFAULT_SCOPES);
      expect(await tokenScopes(code)).toEqual(DEFAULT_SCOPES);
    },
  );

  it.each([null, undefined])("handles a parsed scope of %j", async (scope) => {
    overrideParsedScope = true;
    parsedScope = scope;
    const page = await consentPage();
    for (const value of DEFAULT_SCOPES) {
      expect(page.html).toContain(`name="scope" value="${value}" checked`);
    }
    const { code } = await approve(DEFAULT_SCOPES);
    expect(await tokenScopes(code)).toEqual(DEFAULT_SCOPES);
  });

  it("preserves explicitly requested scopes", async () => {
    authorizeUrl.searchParams.set("scope", "location:read");
    const page = await consentPage();
    expect(page.html).toContain('name="scope" value="location:read" checked');
    expect(page.html).not.toContain('value="geofence:write"');
    const { code } = await approve(["location:read"]);
    expect(await tokenScopes(code)).toEqual(["location:read"]);
  });

  it.each([{ scope: ["location:read"] }, { scope: [] }])(
    "respects a narrowed approval of $scope",
    async ({ scope }) => {
      const { code } = await approve(scope);
      expect(await tokenScopes(code)).toEqual(scope);
    },
  );

  it("reuses remembered consent for defaults", async () => {
    const { response } = await approve(DEFAULT_SCOPES);
    const approvals = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-oauth-approvals="))!;
    const remembered = await fetch(authorizeUrl, {
      headers: { Cookie: `${cookie}; ${approvals.split(";")[0]}` },
    });
    expect(remembered.status).toBe(302);
    const code = new URL(remembered.headers.get("Location")!).searchParams.get(
      "code",
    )!;
    expect(await tokenScopes(code)).toEqual(DEFAULT_SCOPES);
  });

  it("does not reuse narrower remembered consent for defaults", async () => {
    const { response } = await approve(["location:read"]);
    const approvals = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-oauth-approvals="))!;
    cookie = `${cookie}; ${approvals.split(";")[0]}`;
    const page = await consentPage();
    expect(page.html).toContain('name="scope" value="geofence:write" checked');
  });
});

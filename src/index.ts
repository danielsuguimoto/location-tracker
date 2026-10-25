import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { Hono } from "hono";
import type { Env } from "./env";
import { createServer } from "./mcp";
import { handleIngest } from "./ingest";
import {
  checkPassword,
  signSessionValue,
  sessionCookieHeader,
  clearSessionCookieHeader,
  originAllowed,
  clientIp,
  loginBlocked,
  recordLoginFailure,
  clearLoginFailures,
} from "./session";
import { admin } from "./admin/routes";
import { handleAuthorize } from "./admin/consent";
import { esc, htmlResponse } from "./admin/views";

const app = new Hono<{ Bindings: Env }>();

app.post("/pub", (c) => handleIngest(c.req.raw, c.env, c.executionCtx));

app.get("/health", (c) => c.json({ ok: true }));

function loginPage(next: string, error = ""): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · location-tracker</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:22rem;margin:4rem auto;padding:0 1rem}
input{width:100%;padding:.5rem;margin:.4rem 0}button{padding:.5rem 1rem}</style></head>
<body><h1>location-tracker</h1>
${error ? `<p style="color:#c00">${esc(error)}</p>` : ""}
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(next)}">
<input type="password" name="password" placeholder="Password" required autofocus>
<button type="submit">Sign in</button>
</form></body></html>`;
}

app.get("/login", (c) => {
  const next = c.req.query("next") ?? "/admin";
  return htmlResponse(loginPage(next.startsWith("/") ? next : "/admin"));
});

app.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const next = String(form.next ?? "/admin");
  const safeNext = next.startsWith("/") ? next : "/admin";
  if (!originAllowed(c.req.raw, c.env)) {
    return htmlResponse(loginPage(safeNext, "Forbidden"), 403);
  }
  const ip = clientIp(c.req.raw);
  if (await loginBlocked(c.env, ip)) {
    return htmlResponse(
      loginPage(safeNext, "Too many attempts, try again later"),
      429,
    );
  }
  const ok = await checkPassword(
    String(form.password ?? ""),
    c.env.ADMIN_PASSWORD,
  );
  if (!ok) {
    await recordLoginFailure(c.env, ip);
    return htmlResponse(loginPage(safeNext, "Wrong password"), 401);
  }
  await clearLoginFailures(c.env, ip);
  const value = await signSessionValue(
    c.env.ADMIN_PASSWORD,
    Math.floor(Date.now() / 1000),
  );
  return new Response(null, {
    status: 302,
    headers: {
      Location: safeNext,
      "Set-Cookie": sessionCookieHeader(value),
    },
  });
});

app.post("/logout", (c) => {
  return new Response(null, {
    status: 302,
    headers: { Location: "/login", "Set-Cookie": clearSessionCookieHeader() },
  });
});

app.all("/authorize", (c) => handleAuthorize(c.req.raw, c.env));

app.route("/admin", admin);

app.get("/", (c) => c.redirect("/admin"));

app.notFound((c) => new Response("Not found", { status: 404 }));

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = env.PUBLIC_BASE_URL ?? new URL(request.url).origin;
    const provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: {
        fetch: (req, e, c) =>
          createMcpHandler(() => createServer(e), { route: "/mcp" })(
            req,
            e,
            c,
          ),
      },
      defaultHandler: app,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: ["location:read", "geofence:write"],
      resourceMetadata: {
        resource: `${origin}/mcp`,
        resource_name: "location-tracker",
      },
    });
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

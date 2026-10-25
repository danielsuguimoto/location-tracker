import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { verifySession, originAllowed } from "../session";
import { esc } from "./views";

const enc = new TextEncoder();

async function rememberSecret(env: Env): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(`consent:${env.ADMIN_PASSWORD}`),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = esc(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${esc(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const scopes = details.scope
    .map(
      (s) =>
        `<label><input type="checkbox" name="scope" value="${esc(s)}" checked> ${esc(s)}</label>`,
    )
    .join("<br>");
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.6}</style>
<h1>Allow ${name} to access your location?</h1>
<p>${origin} Access will be sent to <strong>${esc(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>" : ""}
<form method="post">
  <input type="hidden" name="handle" value="${esc(handle)}">
  ${scopes}
  <p><button name="decision" value="approve">Allow</button>
     <button name="decision" value="deny">Deny</button></p>
</form>`;
}

export async function handleAuthorize(
  request: Request,
  env: Env,
): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const now = Math.floor(Date.now() / 1000);
  const authed = await verifySession(
    request.headers.get("Cookie"),
    env.ADMIN_PASSWORD,
    now,
  );
  try {
    if (request.method === "GET") {
      if (!authed) {
        const next = `/authorize${new URL(request.url).search}`;
        return Response.redirect(
          `${new URL(request.url).origin}/login?next=${encodeURIComponent(next)}`,
          302,
        );
      }
      const authRequest = await oauth.parseAuthRequest(request);
      const remember = { secret: await rememberSecret(env), subject: "jun" };
      if (await oauth.isConsentRemembered(request, authRequest, remember)) {
        const { redirectTo } = await oauth.completeAuthorization({
          request: authRequest,
          userId: "jun",
          metadata: {},
          scope: authRequest.scope,
          props: {
            userId: "jun",
            clientId: authRequest.clientId,
            scope: authRequest.scope,
          },
        });
        return Response.redirect(redirectTo, 302);
      }
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      consent.headers.set("X-Frame-Options", "DENY");
      return new Response(consentPage(details, consent.handle), {
        headers: consent.headers,
      });
    }
    if (request.method === "POST") {
      if (!authed) return new Response("Unauthorized", { status: 401 });
      if (!originAllowed(request, env)) {
        return new Response("Forbidden", { status: 403 });
      }
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const remember = { secret: await rememberSecret(env), subject: "jun" };
      const approved = await oauth.approveConsent(request, handle, {
        scope: form.getAll("scope").map(String),
        remember,
      });
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: "jun",
        metadata: {},
        scope: approved.request.scope,
        props: {
          userId: "jun",
          clientId: approved.request.clientId,
          scope: approved.request.scope,
        },
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response("Method not allowed", { status: 405 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (
      error instanceof AuthorizationError ||
      error instanceof CimdFetchError
    ) {
      const message =
        error instanceof AuthorizationError
          ? error.description
          : "This app could not be verified.";
      return new Response(esc(message), {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    throw error;
  }
}

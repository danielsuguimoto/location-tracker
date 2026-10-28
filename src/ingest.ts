import type { Env } from "./env";
import { historySize } from "./env";
import { parseOwnTracksPayload } from "./owntracks";
import {
  insertLocation,
  pruneLocations,
  claimEval,
  evalAndStore,
} from "./db";
import { deliverEvent } from "./notify";
import { safeEqualBytes } from "./session";

const enc = new TextEncoder();

async function checkBasicAuth(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(
      Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)),
    );
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  const userOk = safeEqualBytes(
    enc.encode(user),
    enc.encode(env.OWTRACKS_USER),
  );
  const passOk = safeEqualBytes(
    enc.encode(pass),
    enc.encode(env.OWTRACKS_PASSWORD),
  );
  return userOk && passOk;
}

const EMPTY_FRIENDS = () =>
  new Response("[]", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

export async function handleIngest(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!(await checkBasicAuth(request, env))) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="owntracks"' },
    });
  }
  const body = await request.text();
  const parsed = parseOwnTracksPayload(body);
  if (parsed.kind !== "location") return EMPTY_FRIENDS();

  const loc = parsed.location;
  // Stale uploads (older tst) are kept in history but must not move "current"
  // location or geofence state; exact replays are dropped entirely. Dedupe
  // claims live in eval_fixes, uncapped by history pruning.
  const claim = await claimEval(env.DB, loc.tst, loc.lat, loc.lon);
  if (claim.kind === "replay") return EMPTY_FRIENDS();
  if (claim.kind === "eval") {
    // Atomic batch: stale guard + insert + per-fence CAS + eval marker + prune.
    const fired = await evalAndStore(
      env.DB,
      loc,
      claim.evalId,
      historySize(env),
    );
    if (fired === null) {
      // Lost the race to a newer tst: keep the row as history, skip eval.
      await insertLocation(env.DB, loc);
      await pruneLocations(env.DB, historySize(env));
      return EMPTY_FRIENDS();
    }
    for (const { fence, event, actions } of fired) {
      ctx.waitUntil(deliverEvent(env, fence, event, loc, actions));
    }
  } else {
    await insertLocation(env.DB, loc);
    await pruneLocations(env.DB, historySize(env));
  }
  return EMPTY_FRIENDS();
}

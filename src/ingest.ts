import type { Env } from "./env";
import { historySize } from "./env";
import { parseOwnTracksPayload } from "./owntracks";
import {
  insertLocation,
  pruneLocations,
  listGeofences,
  casGeofenceState,
  claimLatestTst,
} from "./db";
import { haversineMeters, transitionEvent, type GeofenceState } from "./geo";
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
  await insertLocation(env.DB, loc);
  await pruneLocations(env.DB, historySize(env));

  // Stale/duplicate uploads (replays, out-of-order queued fixes) are kept in
  // history but must not move "current" location or geofence state. The CAS
  // on meta.last_tst also serializes concurrent ingests: losers see no change.
  const isNewest = await claimLatestTst(env.DB, loc.tst);
  if (isNewest) {
    const fences = await listGeofences(env.DB);
    const firedAt = Math.floor(Date.now() / 1000);
    for (const fence of fences) {
      const inside =
        haversineMeters(loc.lat, loc.lon, fence.lat, fence.lon) <=
        fence.radius_m;
      const current: GeofenceState = inside ? "inside" : "outside";
      const event = transitionEvent(fence.last_state, current);
      if (event === null && fence.last_state !== null) continue;
      const wants =
        event === "enter" ? fence.on_enter === 1 : event === "exit" ? fence.on_exit === 1 : false;
      const won = await casGeofenceState(
        env.DB,
        fence.id,
        fence.last_state,
        current,
        event && wants ? firedAt : null,
      );
      if (won && event && wants) {
        const fenceCopy = { ...fence, last_state: current };
        ctx.waitUntil(deliverEvent(env, fenceCopy, event, loc));
      }
    }
  }
  return EMPTY_FRIENDS();
}

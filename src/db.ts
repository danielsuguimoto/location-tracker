import type { LocationUpdate } from "./owntracks";
import { haversineMeters, type GeofenceState } from "./geo";

export interface LocationRow {
  id: number;
  device: string | null;
  lat: number;
  lon: number;
  acc: number | null;
  alt: number | null;
  vel: number | null;
  cog: number | null;
  batt: number | null;
  trigger: string | null;
  tst: number;
  received_at: number;
}

export interface WebhookRow {
  id: string;
  client_id: string;
  label: string;
  url: string;
  token: string | null;
  created_at: number;
}

export interface GeofenceRow {
  id: string;
  client_id: string;
  name: string;
  lat: number;
  lon: number;
  radius_m: number;
  on_enter: number;
  on_exit: number;
  webhook_id: string;
  last_state: GeofenceState | null;
  last_fired_at: number | null;
  created_at: number;
}

export interface DeliveryRow {
  id: number;
  geofence_id: string;
  event: string;
  payload: string | null;
  http_status: number | null;
  error: string | null;
  attempted_at: number;
}

const LOCATION_COLS =
  "id, device, lat, lon, acc, alt, vel, cog, batt, trigger, tst, received_at";

export function insertLocationStmt(
  db: D1Database,
  loc: LocationUpdate,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO locations (device, lat, lon, acc, alt, vel, cog, batt, trigger, tst, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      loc.device,
      loc.lat,
      loc.lon,
      loc.acc,
      loc.alt,
      loc.vel,
      loc.cog,
      loc.batt,
      loc.trigger,
      loc.tst,
      loc.raw,
    );
}

export async function insertLocation(
  db: D1Database,
  loc: LocationUpdate,
): Promise<void> {
  await insertLocationStmt(db, loc).run();
}

export async function pruneLocations(
  db: D1Database,
  keep: number,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM locations WHERE id NOT IN
       (SELECT id FROM locations ORDER BY tst DESC, id DESC LIMIT ?)`,
    )
    .bind(keep)
    .run();
}

export async function latestLocation(
  db: D1Database,
): Promise<LocationRow | null> {
  // "Current" = the last fix that claimed evaluation, resolved through
  // eval_fixes so a stored-but-rejected replay can't impersonate it.
  const evaluated = await db
    .prepare(
      `SELECT ${LOCATION_COLS} FROM locations WHERE id = (
         SELECT l2.id FROM locations l2
         JOIN eval_fixes e ON e.tst = l2.tst AND e.lat = l2.lat AND e.lon = l2.lon
         WHERE e.id = (SELECT value FROM meta WHERE key = 'last_eval_id')
         ORDER BY l2.id LIMIT 1)`,
    )
    .first<LocationRow>();
  if (evaluated) return evaluated;
  return db
    .prepare(
      `SELECT ${LOCATION_COLS} FROM locations ORDER BY tst DESC, id DESC LIMIT 1`,
    )
    .first<LocationRow>();
}

export async function listLocations(
  db: D1Database,
  limit: number,
): Promise<LocationRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${LOCATION_COLS} FROM locations ORDER BY tst DESC, id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<LocationRow>();
  return results;
}

export type EvalClaim =
  | { kind: "eval"; evalId: number }
  | { kind: "stale" }
  | { kind: "replay" };

// Decides whether an upload may update "current" location and geofence
// state. Dedupe claims live in eval_fixes (uncapped by history pruning):
// a strictly newer tst wins outright; at equal tst, the unique insert
// separates a distinct same-second fix from an exact replay.
export async function claimEval(
  db: D1Database,
  tst: number,
  lat: number,
  lon: number,
): Promise<EvalClaim> {
  await db
    .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('last_tst', 0)")
    .run();
  const { meta } = await db
    .prepare(
      "UPDATE meta SET value = ? WHERE key = 'last_tst' AND value < ?",
    )
    .bind(tst, tst)
    .run();
  if ((meta.changes ?? 0) > 0) {
    // Timestamp advanced: dedupe rows for older timestamps are useless.
    await db.prepare("DELETE FROM eval_fixes WHERE tst < ?").bind(tst).run();
    const ins = await db
      .prepare("INSERT OR IGNORE INTO eval_fixes (tst, lat, lon) VALUES (?, ?, ?)")
      .bind(tst, lat, lon)
      .run();
    if ((ins.meta.changes ?? 0) === 0) return { kind: "replay" };
    return { kind: "eval", evalId: Number(ins.meta.last_row_id) };
  }
  const row = await db
    .prepare("SELECT value FROM meta WHERE key = 'last_tst'")
    .first<{ value: number }>();
  if (!row || row.value !== tst) return { kind: "stale" };
  const ins = await db
    .prepare("INSERT OR IGNORE INTO eval_fixes (tst, lat, lon) VALUES (?, ?, ?)")
    .bind(tst, lat, lon)
    .run();
  if ((ins.meta.changes ?? 0) === 0) return { kind: "replay" };
  return { kind: "eval", evalId: Number(ins.meta.last_row_id) };
}

const WEBHOOK_COLS = "id, client_id, label, url, token, created_at";

export async function createWebhook(
  db: D1Database,
  w: { client_id: string; label: string; url: string; token: string | null },
): Promise<WebhookRow> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO webhooks (id, client_id, label, url, token) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, w.client_id, w.label, w.url, w.token)
    .run();
  return (await getWebhook(db, id))!;
}

export async function getWebhook(
  db: D1Database,
  id: string,
): Promise<WebhookRow | null> {
  return db
    .prepare(`SELECT ${WEBHOOK_COLS} FROM webhooks WHERE id = ?`)
    .bind(id)
    .first<WebhookRow>();
}

export async function findWebhookByUrlToken(
  db: D1Database,
  clientId: string,
  url: string,
  token: string | null,
): Promise<WebhookRow | null> {
  return db
    .prepare(
      `SELECT ${WEBHOOK_COLS} FROM webhooks
       WHERE client_id = ? AND url = ? AND (token = ? OR (token IS NULL AND ? IS NULL))`,
    )
    .bind(clientId, url, token, token)
    .first<WebhookRow>();
}

export async function getOrCreateWebhook(
  db: D1Database,
  clientId: string,
  url: string,
  token: string | null,
): Promise<WebhookRow> {
  const existing = await findWebhookByUrlToken(db, clientId, url, token);
  if (existing) return existing;
  const host = new URL(url).host;
  return createWebhook(db, {
    client_id: clientId,
    label: `${host} (auto)`,
    url,
    token,
  });
}

export async function listWebhooks(
  db: D1Database,
  clientId?: string,
): Promise<WebhookRow[]> {
  const sql = clientId
    ? `SELECT ${WEBHOOK_COLS} FROM webhooks WHERE client_id = ? ORDER BY created_at DESC`
    : `SELECT ${WEBHOOK_COLS} FROM webhooks ORDER BY created_at DESC`;
  const stmt = db.prepare(sql);
  const { results } = await (clientId ? stmt.bind(clientId) : stmt).all<WebhookRow>();
  return results;
}

export async function updateWebhook(
  db: D1Database,
  id: string,
  patch: { label?: string; url?: string; token?: string | null },
): Promise<boolean> {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return true;
  values.push(id);
  const { meta } = await db
    .prepare(`UPDATE webhooks SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  return (meta.changes ?? 0) > 0;
}

export async function deleteWebhook(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const { meta } = await db
    .prepare("DELETE FROM webhooks WHERE id = ?")
    .bind(id)
    .run();
  return (meta.changes ?? 0) > 0;
}

const GEOFENCE_COLS =
  "id, client_id, name, lat, lon, radius_m, on_enter, on_exit, webhook_id, last_state, last_fired_at, created_at";

export interface NewGeofence {
  client_id: string;
  name: string;
  lat: number;
  lon: number;
  radius_m: number;
  on_enter: boolean;
  on_exit: boolean;
  webhook_id: string;
}

export async function createGeofence(
  db: D1Database,
  g: NewGeofence,
): Promise<GeofenceRow> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO geofences
       (id, client_id, name, lat, lon, radius_m, on_enter, on_exit, webhook_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      g.client_id,
      g.name,
      g.lat,
      g.lon,
      g.radius_m,
      g.on_enter ? 1 : 0,
      g.on_exit ? 1 : 0,
      g.webhook_id,
    )
    .run();
  return (await getGeofence(db, id))!;
}

export async function getGeofence(
  db: D1Database,
  id: string,
): Promise<GeofenceRow | null> {
  return db
    .prepare(`SELECT ${GEOFENCE_COLS} FROM geofences WHERE id = ?`)
    .bind(id)
    .first<GeofenceRow>();
}

export async function listGeofences(
  db: D1Database,
  clientId?: string,
): Promise<GeofenceRow[]> {
  const sql = clientId
    ? `SELECT ${GEOFENCE_COLS} FROM geofences WHERE client_id = ? ORDER BY created_at DESC`
    : `SELECT ${GEOFENCE_COLS} FROM geofences ORDER BY created_at DESC`;
  const stmt = db.prepare(sql);
  const { results } = await (clientId
    ? stmt.bind(clientId)
    : stmt
  ).all<GeofenceRow>();
  return results;
}

export interface GeofencePatch {
  name?: string;
  lat?: number;
  lon?: number;
  radius_m?: number;
  on_enter?: boolean;
  on_exit?: boolean;
  webhook_id?: string;
}

export async function updateGeofence(
  db: D1Database,
  id: string,
  patch: GeofencePatch,
): Promise<boolean> {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    fields.push(`${key} = ?`);
    values.push(
      typeof value === "boolean" ? (value ? 1 : 0) : value,
    );
  }
  if (fields.length === 0) return true;
  values.push(id);
  const { meta } = await db
    .prepare(`UPDATE geofences SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  return (meta.changes ?? 0) > 0;
}

export async function deleteGeofence(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const { meta } = await db
    .prepare("DELETE FROM geofences WHERE id = ?")
    .bind(id)
    .run();
  return (meta.changes ?? 0) > 0;
}

export async function setGeofenceState(
  db: D1Database,
  id: string,
  state: GeofenceState | null,
): Promise<void> {
  await db
    .prepare("UPDATE geofences SET last_state = ? WHERE id = ?")
    .bind(state, id)
    .run();
}

export interface FiredEvent {
  fence: GeofenceRow;
  event: "enter" | "exit";
}

// Stores the fix and applies geofence transitions in ONE batch: D1 batches
// are atomic, so fence writes, the eval marker, and the stale guard commit
// or roll back together. The guard statement violates NOT NULL on meta.value
// when last_tst advanced past this fix mid-flight, aborting the whole batch
// (returns null) — a stale claim can never land.
// Per fence, three mutually exclusive CAS statements cover baseline
// (IS NULL), wanted transition (-> current, fires), and unwanted transition.
export async function evalAndStore(
  db: D1Database,
  loc: LocationUpdate,
  evalId: number,
  keep: number,
): Promise<FiredEvent[] | null> {
  const fences = await listGeofences(db);
  const firedAt = Math.floor(Date.now() / 1000);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO meta (key, value) SELECT 'guard', NULL
         WHERE (SELECT value FROM meta WHERE key = 'last_tst') > ?`,
      )
      .bind(loc.tst),
    insertLocationStmt(db, loc),
  ];
  const fireAt = new Map<number, { fence: GeofenceRow; event: "enter" | "exit" }>();
  for (const fence of fences) {
    const inside =
      haversineMeters(loc.lat, loc.lon, fence.lat, fence.lon) <=
      fence.radius_m;
    const current: GeofenceState = inside ? "inside" : "outside";
    const opposite: GeofenceState = inside ? "outside" : "inside";
    const want = inside ? "on_enter = 1" : "on_exit = 1";
    stmts.push(
      db
        .prepare(
          "UPDATE geofences SET last_state = ? WHERE id = ? AND last_state IS NULL",
        )
        .bind(current, fence.id),
    );
    fireAt.set(stmts.length, {
      fence: { ...fence, last_state: current },
      event: inside ? "enter" : "exit",
    });
    stmts.push(
      db
        .prepare(
          `UPDATE geofences SET last_state = ?, last_fired_at = ?
           WHERE id = ? AND last_state = ? AND ${want}`,
        )
        .bind(current, firedAt, fence.id, opposite),
      db
        .prepare(
          `UPDATE geofences SET last_state = ?
           WHERE id = ? AND last_state = ? AND NOT ${want}`,
        )
        .bind(current, fence.id, opposite),
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('last_eval_id', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(evalId),
    db
      .prepare(
        `DELETE FROM locations WHERE id NOT IN
         (SELECT id FROM locations ORDER BY tst DESC, id DESC LIMIT ?)`,
      )
      .bind(keep),
  );
  let results: D1Result<unknown>[];
  try {
    results = await db.batch(stmts);
  } catch {
    return null;
  }
  const fired: FiredEvent[] = [];
  for (const [idx, f] of fireAt) {
    if ((results[idx]!.meta?.changes ?? 0) > 0) fired.push(f);
  }
  return fired;
}

// Recompute last_state from the latest location after a geometry edit,
// without firing. No recorded location -> reset to baseline (null).
export async function rebaselineGeofence(
  db: D1Database,
  fence: GeofenceRow,
): Promise<void> {
  const latest = await latestLocation(db);
  const inside = latest
    ? haversineMeters(latest.lat, latest.lon, fence.lat, fence.lon) <=
      fence.radius_m
    : null;
  await setGeofenceState(
    db,
    fence.id,
    inside === null ? null : inside ? "inside" : "outside",
  );
}

export async function insertDelivery(
  db: D1Database,
  d: {
    geofence_id: string;
    event: string;
    payload: string;
    http_status: number | null;
    error: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO deliveries (geofence_id, event, payload, http_status, error)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(d.geofence_id, d.event, d.payload, d.http_status, d.error)
    .run();
}

export async function pruneDeliveries(
  db: D1Database,
  keep = 200,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM deliveries WHERE id NOT IN
       (SELECT id FROM deliveries ORDER BY id DESC LIMIT ?)`,
    )
    .bind(keep)
    .run();
}

export async function listDeliveries(
  db: D1Database,
  limit: number,
): Promise<DeliveryRow[]> {
  const { results } = await db
    .prepare(
      "SELECT id, geofence_id, event, payload, http_status, error, attempted_at FROM deliveries ORDER BY id DESC LIMIT ?",
    )
    .bind(limit)
    .all<DeliveryRow>();
  return results;
}

export async function lastDeliveryForGeofences(
  db: D1Database,
  ids: string[],
): Promise<Map<string, DeliveryRow>> {
  const map = new Map<string, DeliveryRow>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT d.id, d.geofence_id, d.event, d.payload, d.http_status, d.error, d.attempted_at
       FROM deliveries d
       JOIN (SELECT geofence_id, MAX(id) AS max_id FROM deliveries WHERE geofence_id IN (${placeholders}) GROUP BY geofence_id) latest
       ON d.id = latest.max_id`,
    )
    .bind(...ids)
    .all<DeliveryRow>();
  for (const row of results) map.set(row.geofence_id, row);
  return map;
}

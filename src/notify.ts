import type { Env } from "./env";
import type { GeofenceActionRow, GeofenceRow, WebhookRow } from "./db";
import { getWebhook, insertDelivery, pruneDeliveries } from "./db";
import type { GeofenceEvent } from "./geo";

export interface EventLocation {
  lat: number;
  lon: number;
  acc: number | null;
  tst: number;
  device: string | null;
}

export function buildEventPayload(
  fence: GeofenceRow,
  event: GeofenceEvent | "test",
  loc: EventLocation | null,
  actions: GeofenceActionRow[] = [],
): Record<string, unknown> {
  return {
    event,
    geofence: {
      id: fence.id,
      name: fence.name,
      lat: fence.lat,
      lon: fence.lon,
      radius_m: fence.radius_m,
    },
    location: loc
      ? {
          lat: loc.lat,
          lon: loc.lon,
          acc: loc.acc,
          tst: loc.tst,
          device: loc.device,
        }
      : null,
    actions: actions.map((a) => ({
      id: a.id,
      type: a.action_type,
      message: a.message,
      schedule_type: a.schedule_type,
    })),
    timestamp: Math.floor(Date.now() / 1000),
  };
}

export async function deliverEvent(
  env: Env,
  fence: GeofenceRow,
  event: GeofenceEvent | "test",
  loc: EventLocation | null,
  actions: GeofenceActionRow[] = [],
): Promise<{ status: number | null; error: string | null }> {
  const payload = buildEventPayload(fence, event, loc, actions);
  const body = JSON.stringify(payload);
  const webhook = await getWebhook(env.DB, fence.webhook_id);
  let status: number | null = null;
  let error: string | null = null;
  if (!webhook) {
    error = "webhook endpoint deleted";
  } else {
    try {
      status = await postWebhook(webhook, body);
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  await insertDelivery(env.DB, {
    geofence_id: fence.id,
    event,
    payload: body,
    http_status: status,
    error,
  });
  await pruneDeliveries(env.DB);
  return { status, error };
}

async function postWebhook(webhook: WebhookRow, body: string): Promise<number> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (webhook.token) headers["Authorization"] = `Bearer ${webhook.token}`;
  const res = await fetch(webhook.url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(5000),
  });
  return res.status;
}

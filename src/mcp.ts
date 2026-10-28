import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import type { Env } from "./env";
import { historySize } from "./env";
import {
  latestLocation,
  listLocations,
  createGeofence,
  getGeofence,
  listGeofences,
  updateGeofence,
  deleteGeofence,
  rebaselineGeofence,
  createGeofenceAction,
  getGeofenceAction,
  listGeofenceActions,
  deleteGeofenceAction,
  lastDeliveryForGeofences,
  listWebhooks,
  getWebhook,
  getOrCreateWebhook,
  type LocationRow,
  type GeofenceRow,
  type GeofenceActionRow,
  type WebhookRow,
} from "./db";
import { haversineMeters } from "./geo";
import { deliverEvent } from "./notify";
import { webhookUrlError } from "./url";

const httpsUrl = z.url().refine((v) => new URL(v).protocol === "https:", {
  message: "must be an https URL",
});

function locationJson(row: LocationRow) {
  const now = Math.floor(Date.now() / 1000);
  return {
    lat: row.lat,
    lon: row.lon,
    accuracy_m: row.acc,
    altitude_m: row.alt,
    velocity_ms: row.vel,
    course_deg: row.cog,
    battery_pct: row.batt,
    device: row.device,
    trigger: row.trigger,
    recorded_at: new Date(row.tst * 1000).toISOString(),
    age_seconds: Math.max(0, now - row.tst),
  };
}

function webhookJson(w: WebhookRow) {
  return {
    id: w.id,
    label: w.label,
    url: w.url,
    has_token: w.token !== null,
    created_at: new Date(w.created_at * 1000).toISOString(),
  };
}

function geofenceJson(row: GeofenceRow, webhook?: WebhookRow | null) {
  return {
    id: row.id,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    radius_m: row.radius_m,
    events: [
      ...(row.on_enter ? ["enter"] : []),
      ...(row.on_exit ? ["exit"] : []),
    ],
    webhook_id: row.webhook_id,
    webhook: webhook ? webhookJson(webhook) : null,
    last_state: row.last_state,
    last_fired_at: row.last_fired_at
      ? new Date(row.last_fired_at * 1000).toISOString()
      : null,
    created_at: new Date(row.created_at * 1000).toISOString(),
  };
}

function geofenceActionJson(a: GeofenceActionRow) {
  return {
    id: a.id,
    geofence_id: a.geofence_id,
    trigger: a.trigger,
    type: a.action_type,
    message: a.message,
    schedule_type: a.schedule_type,
    expires_at: a.expires_at
      ? new Date(a.expires_at * 1000).toISOString()
      : null,
    status: a.status,
    last_triggered_at: a.last_triggered_at
      ? new Date(a.last_triggered_at * 1000).toISOString()
      : null,
    created_at: new Date(a.created_at * 1000).toISOString(),
  };
}

const expiresAtInput = z
  .union([
    z.number().int().positive().describe("Unix timestamp (seconds)"),
    z.iso.datetime({ offset: true }).describe("ISO 8601 timestamp"),
  ])
  .transform((v) =>
    typeof v === "number" ? v : Math.floor(new Date(v).getTime() / 1000),
  );

function text(result: unknown) {
  const structured =
    typeof result === "object" && result !== null ? (result as Record<string, unknown>) : undefined;
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(result, null, 2) },
    ],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function clientId(): string {
  const auth = getMcpAuthContext();
  const id = auth?.props?.clientId;
  return typeof id === "string" && id ? id : "unknown";
}

function hasScope(need: string): boolean {
  const scope = getMcpAuthContext()?.props?.scope;
  return Array.isArray(scope) && scope.includes(need);
}

function scopeError(need: string) {
  return text({ error: `insufficient scope: this tool requires '${need}'` });
}

// A client may only reference webhook endpoints it registered (via url+token
// params); admin-managed endpoints stay invisible and unusable to MCP clients.
async function clientWebhook(
  env: Env,
  id: string,
): Promise<WebhookRow | null> {
  const w = await getWebhook(env.DB, id);
  return w && w.client_id === clientId() ? w : null;
}

export function createServer(env: Env): McpServer {
  const server = new McpServer({
    name: "location-tracker",
    version: "1.0.0",
  });

  server.registerTool(
    "get_current_location",
    {
      description:
        "Get the most recently recorded location of the tracked device.",
      inputSchema: {},
    },
    async () => {
      if (!hasScope("location:read")) return scopeError("location:read");
      const row = await latestLocation(env.DB);
      if (!row) {
        return text({ error: "no location recorded yet" });
      }
      return text(locationJson(row));
    },
  );

  server.registerTool(
    "get_location_history",
    {
      description:
        "Get recent location history, newest first. History is capped at the configured retention limit.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Max entries to return; defaults to the full retained history"),
      },
    },
    async ({ limit }) => {
      if (!hasScope("location:read")) return scopeError("location:read");
      const rows = await listLocations(env.DB, limit ?? historySize(env));
      return text({ locations: rows.map(locationJson) });
    },
  );

  server.registerTool(
    "list_webhooks",
    {
      description:
        "List webhook endpoints registered by this MCP client (via webhook_url params). Reference one by id in register_geofence to reuse it. Tokens are never returned.",
      inputSchema: {},
    },
    async () => {
      if (!hasScope("geofence:write")) return scopeError("geofence:write");
      const rows = await listWebhooks(env.DB, clientId());
      return text({ webhooks: rows.map(webhookJson) });
    },
  );

  server.registerTool(
    "register_geofence",
    {
      description:
        "Register for a notification when the tracked device enters or leaves a circular area. Deliveries go to a webhook endpoint: pass webhook_id from list_webhooks to reuse one you registered, or pass webhook_url (+ optional webhook_token) which is deduplicated into your registry. Poke-compatible: a Poke webhookUrl + webhookToken pair works directly.",
      inputSchema: {
        name: z.string().min(1).max(100).describe("Place name, e.g. 'home'"),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        radius_m: z.number().min(1).max(100000).describe("Radius in meters"),
        webhook_id: z
          .string()
          .uuid()
          .optional()
          .describe("Existing webhook endpoint id (from list_webhooks)"),
        webhook_url: httpsUrl
          .optional()
          .describe("HTTPS endpoint; reused/registered on first use"),
        webhook_token: z
          .string()
          .max(500)
          .optional()
          .describe("Sent as 'Authorization: Bearer <token>'"),
        events: z
          .array(z.enum(["enter", "exit"]))
          .min(1)
          .optional()
          .describe("Defaults to both"),
      },
    },
    async ({ name, lat, lon, radius_m, webhook_id, webhook_url, webhook_token, events }) => {
      if (!hasScope("geofence:write")) return scopeError("geofence:write");
      let webhook: WebhookRow | null = null;
      if (webhook_id) {
        webhook = await clientWebhook(env, webhook_id);
        if (!webhook) return text({ error: "webhook_id not found; call list_webhooks" });
      } else if (webhook_url) {
        const urlError = webhookUrlError(webhook_url);
        if (urlError) return text({ error: `webhook_url: ${urlError}` });
        webhook = await getOrCreateWebhook(
          env.DB,
          clientId(),
          webhook_url,
          webhook_token ?? null,
        );
      } else {
        return text({
          error: "provide webhook_id or webhook_url",
        });
      }
      const row = await createGeofence(env.DB, {
        client_id: clientId(),
        name,
        lat,
        lon,
        radius_m,
        on_enter: !events || events.includes("enter"),
        on_exit: !events || events.includes("exit"),
        webhook_id: webhook.id,
      });
      const latest = await latestLocation(env.DB);
      const initial_state = latest
        ? haversineMeters(latest.lat, latest.lon, lat, lon) <= radius_m
          ? "inside"
          : "outside"
        : "unknown";
      return text({
        id: row.id,
        initial_state,
        webhook: webhookJson(webhook),
      });
    },
  );

  server.registerTool(
    "list_geofences",
    {
      description:
        "List geofence subscriptions created by this MCP client, with current inside/outside state and last delivery status.",
      inputSchema: {},
    },
    async () => {
      if (!hasScope("geofence:write")) return scopeError("geofence:write");
      const rows = await listGeofences(env.DB, clientId());
      const lastDeliveries = await lastDeliveryForGeofences(
        env.DB,
        rows.map((r) => r.id),
      );
      const webhooks = new Map(
        (await listWebhooks(env.DB, clientId())).map((w) => [w.id, w]),
      );
      return text({
        geofences: rows.map((r) => ({
          ...geofenceJson(r, webhooks.get(r.webhook_id)),
          last_delivery: (() => {
            const d = lastDeliveries.get(r.id);
            return d
              ? {
                  event: d.event,
                  http_status: d.http_status,
                  error: d.error,
                  at: new Date(d.attempted_at * 1000).toISOString(),
                }
              : null;
          })(),
        })),
      });
    },
  );

  server.registerTool(
    "update_geofence",
    {
      description: "Update a geofence subscription created by this MCP client.",
      inputSchema: {
        id: z.string().uuid(),
        name: z.string().min(1).max(100).optional(),
        lat: z.number().min(-90).max(90).optional(),
        lon: z.number().min(-180).max(180).optional(),
        radius_m: z.number().min(1).max(100000).optional(),
        webhook_id: z
          .string()
          .uuid()
          .optional()
          .describe("Existing webhook endpoint id (from list_webhooks)"),
        webhook_url: httpsUrl
          .optional()
          .describe("Reused/registered as a webhook endpoint"),
        webhook_token: z
          .string()
          .max(500)
          .optional()
          .describe("Only used together with webhook_url"),
        events: z.array(z.enum(["enter", "exit"])).min(1).optional(),
      },
    },
    async ({ id, events, webhook_id, webhook_url, webhook_token, ...patch }) => {
      if (!hasScope("geofence:write")) return scopeError("geofence:write");
      const existing = await getGeofence(env.DB, id);
      if (!existing || existing.client_id !== clientId()) {
        return text({ error: "geofence not found" });
      }
      let resolvedWebhookId = webhook_id;
      if (!resolvedWebhookId && webhook_url) {
        const urlError = webhookUrlError(webhook_url);
        if (urlError) return text({ error: `webhook_url: ${urlError}` });
        resolvedWebhookId = (
          await getOrCreateWebhook(env.DB, clientId(), webhook_url, webhook_token ?? null)
        ).id;
      }
      if (resolvedWebhookId) {
        const w = await clientWebhook(env, resolvedWebhookId);
        if (!w) return text({ error: "webhook_id not found" });
      }
      await updateGeofence(env.DB, id, {
        ...patch,
        ...(resolvedWebhookId ? { webhook_id: resolvedWebhookId } : {}),
        ...(events
          ? { on_enter: events.includes("enter"), on_exit: events.includes("exit") }
          : {}),
      });
      // Geometry edits invalidate last_state; rebaseline so the next upload
      // doesn't emit a movement event caused only by the boundary change.
      if (
        patch.lat !== undefined ||
        patch.lon !== undefined ||
        patch.radius_m !== undefined
      ) {
        const moved = await getGeofence(env.DB, id);
        if (moved) await rebaselineGeofence(env.DB, moved);
      }
      const updated = await getGeofence(env.DB, id);
      const webhook = updated
        ? await getWebhook(env.DB, updated.webhook_id)
        : null;
      return text({ geofence: updated ? geofenceJson(updated, webhook) : null });
    },
  );

  server.registerTool(
    "unregister_geofence",
    {
      description: "Delete a geofence subscription created by this MCP client.",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      if (!hasScope("geofence:write")) return scopeError("geofence:write");
      const existing = await getGeofence(env.DB, id);
      if (!existing || existing.client_id !== clientId()) {
        return text({ error: "geofence not found" });
      }
      await deleteGeofence(env.DB, id);
      return text({ deleted: id });
    },
  );

  server.registerTool(
    "create_geofence_action",
    {
      description:
        "Attach a reminder action to a geofence you own. The action rides along in the geofence's webhook payload whenever the chosen trigger fires. schedule_type: 'once' fires a single time then completes, 'always' fires on every matching transition, 'until' fires until expires_at then expires.",
      inputSchema: {
        geofence_id: z.string().uuid().describe("Geofence id (from list_geofences)"),
        trigger: z.enum(["enter", "exit"]),
        message: z.string().min(1).max(500).describe("Reminder text delivered in the webhook payload"),
        schedule_type: z.enum(["once", "always", "until"]),
        expires_at: expiresAtInput
          .optional()
          .describe("Required for schedule_type 'until'"),
      },
    },
    async ({ geofence_id, trigger, message, schedule_type, expires_at }) => {
      if (!hasScope("geofence:write")) return scopeError("geofence:write");
      const fence = await getGeofence(env.DB, geofence_id);
      if (!fence || fence.client_id !== clientId()) {
        return text({ error: "geofence not found" });
      }
      if (schedule_type === "until" && expires_at === undefined) {
        return text({ error: "expires_at is required for schedule_type 'until'" });
      }
      const row = await createGeofenceAction(env.DB, {
        geofence_id,
        trigger,
        message,
        schedule_type,
        expires_at: expires_at ?? null,
      });
      return text({ action: geofenceActionJson(row) });
    },
  );

  server.registerTool(
    "list_geofence_actions",
    {
      description:
        "List reminder actions on geofences owned by this MCP client, optionally narrowed to one geofence or to active actions only.",
      inputSchema: {
        geofence_id: z
          .string()
          .uuid()
          .optional()
          .describe("Restrict to one geofence (must be yours)"),
        status: z
          .enum(["active", "completed", "expired"])
          .optional()
          .describe("Defaults to all statuses"),
      },
    },
    async ({ geofence_id, status }) => {
      if (!hasScope("geofence:write")) return scopeError("geofence:write");
      if (geofence_id) {
        const fence = await getGeofence(env.DB, geofence_id);
        if (!fence || fence.client_id !== clientId()) {
          return text({ error: "geofence not found" });
        }
      }
      const rows = await listGeofenceActions(env.DB, {
        geofenceId: geofence_id,
        clientId: clientId(),
        status,
      });
      return text({ actions: rows.map(geofenceActionJson) });
    },
  );

  server.registerTool(
    "delete_geofence_action",
    {
      description: "Delete a reminder action on a geofence owned by this MCP client.",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      if (!hasScope("geofence:write")) return scopeError("geofence:write");
      const action = await getGeofenceAction(env.DB, id);
      if (!action) return text({ error: "action not found" });
      const fence = await getGeofence(env.DB, action.geofence_id);
      if (!fence || fence.client_id !== clientId()) {
        return text({ error: "action not found" });
      }
      await deleteGeofenceAction(env.DB, id);
      return text({ deleted: id });
    },
  );

  server.registerTool(
    "test_geofence_notification",
    {
      description:
        "Send a test event to a geofence subscription's webhook and return the delivery result.",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      if (!hasScope("geofence:write")) return scopeError("geofence:write");
      const existing = await getGeofence(env.DB, id);
      if (!existing || existing.client_id !== clientId()) {
        return text({ error: "geofence not found" });
      }
      const latest = await latestLocation(env.DB);
      const result = await deliverEvent(env, existing, "test", latest);
      return text(result);
    },
  );

  return server;
}

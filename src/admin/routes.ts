import { Hono } from "hono";
import type { Env } from "../env";
import { historySize } from "../env";
import { verifySession, originAllowed } from "../session";
import {
  latestLocation,
  listLocations,
  listGeofences,
  createGeofence,
  getGeofence,
  updateGeofence,
  deleteGeofence,
  listDeliveries,
  listWebhooks,
  getWebhook,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  rebaselineGeofence,
} from "../db";
import { webhookUrlError } from "../url";
import { haversineMeters } from "../geo";
import { deliverEvent } from "../notify";
import { esc, page, htmlResponse } from "./views";

const ts = (sec: number | null) =>
  sec ? new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z" : "—";

export const admin = new Hono<{ Bindings: Env }>();

admin.use("/*", async (c, next) => {
  if (c.req.method !== "GET" && !originAllowed(c.req.raw)) {
    return new Response("Forbidden", { status: 403 });
  }
  const ok = await verifySession(
    c.req.header("Cookie") ?? null,
    c.env.ADMIN_PASSWORD,
    Math.floor(Date.now() / 1000),
  );
  if (!ok) {
    const nextUrl = new URL(c.req.url).pathname;
    if (c.req.method === "GET") {
      return c.redirect(`/login?next=${encodeURIComponent(nextUrl)}`);
    }
    return new Response("Unauthorized", { status: 401 });
  }
  await next();
});

admin.get("/", async (c) => {
  const latest = await latestLocation(c.env.DB);
  const fences = await listGeofences(c.env.DB);
  const locHtml = latest
    ? `<div class="card"><strong>Current location</strong><br>
       ${esc(latest.lat)}, ${esc(latest.lon)} ${latest.acc ? `(±${esc(latest.acc)} m)` : ""}<br>
       <span class="muted">recorded ${esc(ts(latest.tst))} · device ${esc(latest.device ?? "—")} · battery ${latest.batt ?? "—"}%</span></div>`
    : `<div class="card"><strong>No location recorded yet.</strong></div>`;
  return htmlResponse(
    page("Dashboard", `${locHtml}
      <p>${fences.length} geofence subscription(s), ${fences.filter((f) => f.last_state === "inside").length} currently inside.</p>
      <p class="muted">History retention: last ${historySize(c.env)} locations.</p>`),
  );
});

admin.get("/locations", async (c) => {
  const rows = await listLocations(c.env.DB, historySize(c.env));
  const trs = rows
    .map(
      (r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.lat)}, ${esc(r.lon)}</td>
      <td>${esc(r.acc ?? "—")}</td><td>${esc(r.batt ?? "—")}</td>
      <td>${esc(r.device ?? "—")}</td><td>${esc(ts(r.tst))}</td>
      <td>${esc(ts(r.received_at))}</td></tr>`,
    )
    .join("");
  return htmlResponse(
    page(
      "Locations",
      `<h1>Recent locations</h1>
      <table><tr><th>#</th><th>lat, lon</th><th>acc m</th><th>batt %</th><th>device</th><th>recorded</th><th>received</th></tr>${trs || '<tr><td colspan="7">none yet</td></tr>'}</table>`,
    ),
  );
});

function webhookOptions(webhooks: { id: string; label: string; url: string }[], selected?: string): string {
  return (
    webhooks
      .map(
        (w) =>
          `<option value="${esc(w.id)}" ${w.id === selected ? "selected" : ""}>${esc(w.label)} — ${esc(w.url)}</option>`,
      )
      .join("") || '<option value="" disabled>(no webhooks — create one first)</option>'
  );
}

admin.get("/geofences", async (c) => {
  const rows = await listGeofences(c.env.DB);
  const webhooks = await listWebhooks(c.env.DB);
  const byId = new Map(webhooks.map((w) => [w.id, w]));
  const trs = rows
    .map((r) => {
      const w = byId.get(r.webhook_id);
      return `<tr>
      <td>${esc(r.name)}</td>
      <td>${esc(r.lat)}, ${esc(r.lon)} (${esc(r.radius_m)} m)</td>
      <td>${[r.on_enter ? "enter" : "", r.on_exit ? "exit" : ""].filter(Boolean).join("+") || "—"}</td>
      <td>${w ? `${esc(w.label)} <code>${esc(w.url)}</code>` : `<span class="muted">deleted webhook ${esc(r.webhook_id.slice(0, 8))}</span>`}</td>
      <td>${esc(r.last_state ?? "—")}</td>
      <td>${esc(ts(r.last_fired_at))}</td>
      <td class="muted">${esc(r.client_id.slice(0, 12))}</td>
      <td>
        <form method="post" action="/admin/geofences/${esc(r.id)}/test" style="display:inline"><button>Test</button></form>
        <a href="/admin/geofences/${esc(r.id)}/edit">Edit</a>
        <form method="post" action="/admin/geofences/${esc(r.id)}/delete" style="display:inline" onsubmit="return confirm('Delete ${esc(r.name)}?')"><button>Delete</button></form>
      </td></tr>`;
    })
    .join("");
  const createForm = webhooks.length
    ? `<h2>Add geofence</h2>
      <form method="post" action="/admin/geofences">
        <p><label>Name</label><input name="name" required maxlength="100"></p>
        <p><label>Latitude</label><input name="lat" required type="number" step="any" min="-90" max="90"></p>
        <p><label>Longitude</label><input name="lon" required type="number" step="any" min="-180" max="180"></p>
        <p><label>Radius (m)</label><input name="radius_m" required type="number" min="1" max="100000" value="200"></p>
        <p><label>Webhook</label><select name="webhook_id" required>${webhookOptions(webhooks)}</select>
           <a href="/admin/webhooks">manage endpoints</a></p>
        <p><label>Events</label>
          <input type="checkbox" name="on_enter" checked> enter
          <input type="checkbox" name="on_exit" checked> exit</p>
        <p><button type="submit">Create</button></p>
      </form>`
    : `<p class="muted">Create a <a href="/admin/webhooks">webhook endpoint</a> first.</p>`;
  return htmlResponse(
    page(
      "Geofences",
      `<h1>Geofences</h1>
      <table><tr><th>Name</th><th>Circle</th><th>Events</th><th>Webhook</th><th>State</th><th>Last fired</th><th>Client</th><th></th></tr>
      ${trs || '<tr><td colspan="8">none yet</td></tr>'}</table>
      ${createForm}`,
    ),
  );
});

admin.post("/geofences", async (c) => {
  const f = await c.req.parseBody();
  const lat = Number(f.lat);
  const lon = Number(f.lon);
  const radius = Number(f.radius_m);
  const webhookId = String(f.webhook_id ?? "");
  const webhook = webhookId ? await getWebhook(c.env.DB, webhookId) : null;
  if (
    !Number.isFinite(lat) || Math.abs(lat) > 90 ||
    !Number.isFinite(lon) || Math.abs(lon) > 180 ||
    !Number.isFinite(radius) || radius < 1 || radius > 100000 ||
    !webhook ||
    !String(f.name ?? "").trim()
  ) {
    return new Response("Invalid input", { status: 400 });
  }
  await createGeofence(c.env.DB, {
    client_id: "admin",
    name: String(f.name).trim().slice(0, 100),
    lat,
    lon,
    radius_m: radius,
    on_enter: f.on_enter === "on",
    on_exit: f.on_exit === "on",
    webhook_id: webhook.id,
  });
  return c.redirect("/admin/geofences");
});

admin.get("/geofences/:id/edit", async (c) => {
  const r = await getGeofence(c.env.DB, c.req.param("id"));
  if (!r) return new Response("Not found", { status: 404 });
  const webhooks = await listWebhooks(c.env.DB);
  return htmlResponse(
    page(
      "Edit geofence",
      `<h1>Edit ${esc(r.name)}</h1>
      <form method="post" action="/admin/geofences/${esc(r.id)}/update">
        <p><label>Name</label><input name="name" required maxlength="100" value="${esc(r.name)}"></p>
        <p><label>Latitude</label><input name="lat" required type="number" step="any" min="-90" max="90" value="${esc(r.lat)}"></p>
        <p><label>Longitude</label><input name="lon" required type="number" step="any" min="-180" max="180" value="${esc(r.lon)}"></p>
        <p><label>Radius (m)</label><input name="radius_m" required type="number" min="1" max="100000" value="${esc(r.radius_m)}"></p>
        <p><label>Webhook</label><select name="webhook_id" required>${webhookOptions(webhooks, r.webhook_id)}</select></p>
        <p><label>Events</label>
          <input type="checkbox" name="on_enter" ${r.on_enter ? "checked" : ""}> enter
          <input type="checkbox" name="on_exit" ${r.on_exit ? "checked" : ""}> exit</p>
        <p><button type="submit">Save</button> <a href="/admin/geofences">Cancel</a></p>
      </form>`,
    ),
  );
});

admin.post("/geofences/:id/update", async (c) => {
  const r = await getGeofence(c.env.DB, c.req.param("id"));
  if (!r) return new Response("Not found", { status: 404 });
  const f = await c.req.parseBody();
  const lat = Number(f.lat);
  const lon = Number(f.lon);
  const radius = Number(f.radius_m);
  const webhookId = String(f.webhook_id ?? "");
  const webhook = webhookId ? await getWebhook(c.env.DB, webhookId) : null;
  if (
    !Number.isFinite(lat) || Math.abs(lat) > 90 ||
    !Number.isFinite(lon) || Math.abs(lon) > 180 ||
    !Number.isFinite(radius) || radius < 1 || radius > 100000 ||
    !webhook ||
    !String(f.name ?? "").trim()
  ) {
    return new Response("Invalid input", { status: 400 });
  }
  const geometryChanged = lat !== r.lat || lon !== r.lon || radius !== r.radius_m;
  await updateGeofence(c.env.DB, r.id, {
    name: String(f.name).trim().slice(0, 100),
    lat,
    lon,
    radius_m: radius,
    webhook_id: webhook.id,
    on_enter: f.on_enter === "on",
    on_exit: f.on_exit === "on",
  });
  if (geometryChanged) {
    const moved = await getGeofence(c.env.DB, r.id);
    if (moved) await rebaselineGeofence(c.env.DB, moved);
  }
  return c.redirect("/admin/geofences");
});

admin.post("/geofences/:id/delete", async (c) => {
  await deleteGeofence(c.env.DB, c.req.param("id"));
  return c.redirect("/admin/geofences");
});

admin.post("/geofences/:id/test", async (c) => {
  const r = await getGeofence(c.env.DB, c.req.param("id"));
  if (!r) return new Response("Not found", { status: 404 });
  const latest = await latestLocation(c.env.DB);
  const result = await deliverEvent(c.env, r, "test", latest);
  return c.redirect(
    `/admin/deliveries?test=${encodeURIComponent(result.status ?? result.error ?? "failed")}`,
  );
});

admin.get("/webhooks", async (c) => {
  const rows = await listWebhooks(c.env.DB);
  const fences = await listGeofences(c.env.DB);
  const refCount = new Map<string, number>();
  for (const f of fences) refCount.set(f.webhook_id, (refCount.get(f.webhook_id) ?? 0) + 1);
  const trs = rows
    .map(
      (w) => `<tr><td>${esc(w.label)}</td><td><code>${esc(w.url)}</code></td>
      <td>${w.token ? "set" : "—"}</td><td>${refCount.get(w.id) ?? 0}</td>
      <td>${esc(ts(w.created_at))}</td>
      <td>
        <a href="/admin/webhooks/${esc(w.id)}/edit">Edit</a>
        <form method="post" action="/admin/webhooks/${esc(w.id)}/delete" style="display:inline" onsubmit="return confirm('Delete webhook ${esc(w.label)}?')"><button>Delete</button></form>
      </td></tr>`,
    )
    .join("");
  return htmlResponse(
    page(
      "Webhooks",
      `<h1>Webhook endpoints</h1>
      <table><tr><th>Label</th><th>URL</th><th>Token</th><th>Used by</th><th>Created</th><th></th></tr>
      ${trs || '<tr><td colspan="6">none yet</td></tr>'}</table>
      <h2>Add webhook</h2>
      <form method="post" action="/admin/webhooks">
        <p><label>Label</label><input name="label" required maxlength="100" placeholder="e.g. Poke · location alerts"></p>
        <p><label>URL</label><input name="url" required type="url" pattern="https://.*" size="45" placeholder="https://…"></p>
        <p><label>Bearer token</label><input name="token" size="45" placeholder="optional — sent as Authorization: Bearer"></p>
        <p><button type="submit">Create</button></p>
      </form>
      <p class="muted">Tip: a Poke <code>create_webhook</code> <code>webhookUrl</code> + <code>webhookToken</code> pair works directly.</p>`,
    ),
  );
});

admin.post("/webhooks", async (c) => {
  const f = await c.req.parseBody();
  const url = String(f.url ?? "");
  const label = String(f.label ?? "").trim().slice(0, 100);
  if (!label || webhookUrlError(url)) {
    return new Response("Invalid input", { status: 400 });
  }
  await createWebhook(c.env.DB, {
    client_id: "admin",
    label,
    url,
    token: String(f.token ?? "").trim() || null,
  });
  return c.redirect("/admin/webhooks");
});

admin.get("/webhooks/:id/edit", async (c) => {
  const w = await getWebhook(c.env.DB, c.req.param("id"));
  if (!w) return new Response("Not found", { status: 404 });
  return htmlResponse(
    page(
      "Edit webhook",
      `<h1>Edit ${esc(w.label)}</h1>
      <form method="post" action="/admin/webhooks/${esc(w.id)}/update">
        <p><label>Label</label><input name="label" required maxlength="100" value="${esc(w.label)}"></p>
        <p><label>URL</label><input name="url" required type="url" pattern="https://.*" size="45" value="${esc(w.url)}"></p>
        <p><label>Bearer token</label><input name="token" size="45" value="${esc(w.token ?? "")}" placeholder="leave empty to clear"></p>
        <p><button type="submit">Save</button> <a href="/admin/webhooks">Cancel</a></p>
      </form>`,
    ),
  );
});

admin.post("/webhooks/:id/update", async (c) => {
  const w = await getWebhook(c.env.DB, c.req.param("id"));
  if (!w) return new Response("Not found", { status: 404 });
  const f = await c.req.parseBody();
  const url = String(f.url ?? "");
  const label = String(f.label ?? "").trim().slice(0, 100);
  if (!label || webhookUrlError(url)) {
    return new Response("Invalid input", { status: 400 });
  }
  await updateWebhook(c.env.DB, w.id, {
    label,
    url,
    token: String(f.token ?? "").trim() || null,
  });
  return c.redirect("/admin/webhooks");
});

admin.post("/webhooks/:id/delete", async (c) => {
  const id = c.req.param("id");
  const fences = await listGeofences(c.env.DB);
  const used = fences.filter((f) => f.webhook_id === id).length;
  if (used > 0) {
    return new Response(
      `Webhook still used by ${used} geofence(s); delete or repoint them first`,
      { status: 409 },
    );
  }
  await deleteWebhook(c.env.DB, id);
  return c.redirect("/admin/webhooks");
});

admin.get("/deliveries", async (c) => {
  const rows = await listDeliveries(c.env.DB, 50);
  const fences = await listGeofences(c.env.DB);
  const names = new Map(fences.map((f) => [f.id, f.name]));
  const notice = c.req.query("test")
    ? `<p>Test delivery result: <strong>${esc(c.req.query("test"))}</strong></p>`
    : "";
  const trs = rows
    .map(
      (d) => `<tr><td>${esc(d.id)}</td><td>${esc(names.get(d.geofence_id) ?? d.geofence_id.slice(0, 8))}</td>
      <td>${esc(d.event)}</td><td>${esc(d.http_status ?? "—")}</td>
      <td>${esc(d.error ?? "")}</td><td>${esc(ts(d.attempted_at))}</td></tr>`,
    )
    .join("");
  return htmlResponse(
    page(
      "Deliveries",
      `<h1>Notification deliveries</h1>${notice}
      <table><tr><th>#</th><th>Geofence</th><th>Event</th><th>HTTP</th><th>Error</th><th>At</th></tr>
      ${trs || '<tr><td colspan="6">none yet</td></tr>'}</table>`,
    ),
  );
});

admin.get("/setup", async (c) => {
  const base =
    c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  return htmlResponse(
    page(
      "Setup",
      `<h1>Setup</h1>
      <div class="card"><h2>OwnTracks app</h2>
      <ol>
        <li>Settings → Mode → <strong>HTTP</strong></li>
        <li>Endpoint URL: <code>${esc(base)}/pub</code></li>
        <li>Authentication: HTTP Basic — user <code>${esc(c.env.OWTRACKS_USER)}</code> and the configured password</li>
        <li>Publish a manual update (or enable significant-changes mode) to send locations</li>
      </ol></div>
      <div class="card"><h2>MCP clients</h2>
      <p>MCP endpoint (Streamable HTTP): <code>${esc(base)}/mcp</code></p>
      <p>Clients connect with OAuth — the browser flow lands on the consent page, which requires the admin login.</p>
      <ul>
        <li><code>get_current_location</code>, <code>get_location_history</code></li>
        <li><code>register_geofence</code>, <code>list_geofences</code>, <code>update_geofence</code>, <code>unregister_geofence</code>, <code>test_geofence_notification</code></li>
      </ul>
      <p>To notify a <a href="https://poke.com">Poke</a> agent: create a webhook via Poke's <code>create_webhook</code>, then register a geofence with that <code>webhookUrl</code> and pass the <code>webhookToken</code> as the Bearer token.</p></div>`,
    ),
  );
});

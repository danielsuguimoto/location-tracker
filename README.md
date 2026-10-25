# location-tracker

A single Cloudflare Worker that:

- Receives [OwnTracks](https://owntracks.org/booklet/) HTTP-mode location updates at `POST /pub` (HTTP Basic auth).
- Stores them in D1, retaining only the `HISTORY_SIZE` most recent (default 10) to stay inside free-tier limits.
- Serves a remote MCP server at `/mcp` (Streamable HTTP, OAuth 2.1 with dynamic client registration) exposing location and geofence tools.
- Fires Poke-style webhook POSTs when the device enters or leaves agent-registered geofences.
- Hosts a password-protected admin web app (`/admin`) for managing webhooks, viewing locations and delivery logs.

## Deploy

```sh
npm install

# 1. Create the D1 database and put its id in wrangler.jsonc
wrangler d1 create location-tracker-db
wrangler d1 execute location-tracker-db --remote --file schema.sql

# 2. Create the KV namespace used by the OAuth provider (tokens/grants/clients)
wrangler kv namespace create location-tracker-oauth-kv
#    -> put the returned id (and preview_id) into wrangler.jsonc's OAUTH_KV binding

# 3. Secrets
wrangler secret put ADMIN_PASSWORD      # admin web app + OAuth consent login
wrangler secret put OWTRACKS_USER       # e.g. owntracks
wrangler secret put OWTRACKS_PASSWORD   # password the phone will send

wrangler deploy
```

Local dev: `cp .dev.vars.example .dev.vars`, fill in values, then `npm run dev` and `npm run db:migrate:local`.

Upgrading a database created before webhook ownership was added? Run `wrangler d1 execute location-tracker-db --remote --file migrations/0001_webhooks_client_id.sql` once — it backfills `client_id = 'admin'` on existing endpoints.

## Configure the phone

In the OwnTracks app (iOS/Android):

1. Settings → Mode → **HTTP**
2. URL: `https://<your-worker>.workers.dev/pub`
3. Authentication: HTTP Basic with `OWTRACKS_USER` / `OWTRACKS_PASSWORD`
4. Publish manually once — `GET /admin/locations` should show the row.

Only `_type: "location"` payloads are stored; everything else gets `200 []`.

## Connect an MCP client

Point the client at `https://<your-worker>.workers.dev/mcp`. It will run the OAuth flow; the `/authorize` consent page requires the admin password login. Approved grants issue bearer tokens (1 h access, 30 d refresh).

### Tools

| Tool | Purpose |
|---|---|
| `get_current_location` | Latest recorded location (lat/lon/acc/batt/timestamp/age) |
| `get_location_history` | Recent history, newest first (≤ `HISTORY_SIZE`) |
| `list_webhooks` | Registered webhook endpoints (id, label, url — never tokens) |
| `register_geofence` | `name`, `lat`, `lon`, `radius_m`, `events` + either `webhook_id` (reuse a registered endpoint) or `webhook_url` + optional `webhook_token` (deduplicated into the registry) → `{id, initial_state, webhook}` |
| `list_geofences` | Caller's subscriptions + state + last delivery |
| `update_geofence` / `unregister_geofence` | Patch / delete a subscription (owner client only) |
| `test_geofence_notification` | Sends a `test` event to the webhook, returns delivery result |

Scopes: `location:read` gates the location tools, `geofence:write` gates all webhook/geofence tools — a client without a granted scope gets an `insufficient scope` error. Geofences **and webhook endpoints** are scoped to the OAuth `client_id` that created them; the admin UI manages all endpoints, which stay invisible to MCP clients. `webhook_url` values must be public HTTPS (private IPs, localhost, and cloud-metadata hosts are rejected).

## Notifications (Poke-compatible)

Webhook endpoints are managed in the admin UI (`/admin/webhooks`): label + HTTPS URL + optional bearer token. Geofences reference an endpoint by id, so one endpoint can serve many geofences; MCP `register_geofence` may also pass `webhook_url`/`webhook_token` directly — identical pairs dedupe onto the existing endpoint.

On a state transition the worker POSTs to the endpoint:

```json
{
  "event": "enter" | "exit" | "test",
  "geofence": {"id": "…", "name": "home", "lat": 0, "lon": 0, "radius_m": 200},
  "location": {"lat": 0, "lon": 0, "acc": 5, "tst": 0, "device": "JJ"},
  "message": "Jun arrived at \"home\"",
  "timestamp": 0
}
```

`Authorization: Bearer <token>` is sent when the endpoint has a token. To reach a **Poke** agent, create a trigger with Poke's `create_webhook` and register its `webhookUrl` + `webhookToken` as an endpoint. Any other HTTPS endpoint works too.

Semantics: the first location observed after registration sets the baseline state and does **not** fire (use `initial_state` instead); subsequent inside↔outside flips fire once each — each upload's store + transitions + eval marker commit in one atomic D1 batch, so overlapping uploads can't double-fire or desync "current" from geofence state. Uploads are ordered by the device-reported `tst`: an out-of-order fix (queued upload arriving late) is stored in history but doesn't become "current" or move geofence state, and an exact replay (same tst+coords) is dropped before storage. Editing a geofence's circle re-baselines `last_state` from the latest location, so boundary changes never fire movement events. One delivery attempt per event, 5 s timeout, every attempt logged to the `deliveries` table (last 200 kept).

## Admin app

`https://<your-worker>.workers.dev/admin` — sign in with `ADMIN_PASSWORD` (HMAC session cookie, 7 days, `__Host-` `Secure` `SameSite=Lax`). Login attempts are throttled per source IP (5 failures → 15 min lockout via KV), and all POSTs check `Origin` against the request host. Dashboard, recent locations, **webhook endpoint registry**, geofence CRUD + test-fire, delivery log, and a `/admin/setup` page with copy-paste instructions. A webhook can't be deleted while geofences still reference it.

## Notes / limits

- Workers Free: 100k requests/day, 10 ms CPU, 50 subrequests/invocation (each fired geofence webhook = 1 subrequest).
- D1 Free: 100k rows written/day, 5 GB — a 1/minute tracker uses ~3k writes/day.
- KV (OAuth state): reads are plentiful; writes are a handful per grant.
- `resourceMetadata.resource` is derived per-request from the URL origin, so dev (`http://localhost`) and any custom domain both work; set `PUBLIC_BASE_URL` to pin a canonical origin.
- Secrets never go in `wrangler.jsonc` vars; `.dev.vars` is gitignored.

# location-tracker

A single Cloudflare Worker that:

- Receives [OwnTracks](https://owntracks.org/booklet/) HTTP-mode location updates at `POST /pub` (HTTP Basic auth).
- Stores them in D1, retaining only the `HISTORY_SIZE` most recent (default 10) to stay inside free-tier limits.
- Serves a remote MCP server at `/mcp` (Streamable HTTP, OAuth 2.1 with dynamic client registration) exposing location and geofence tools.
- Fires Poke-style webhook POSTs when the device enters or leaves agent-registered geofences, carrying any contextual reminder actions that fired with them.
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

Upgrading an existing database? Apply any pending migrations in order — `wrangler d1 execute location-tracker-db --remote --file migrations/0001_webhooks_client_id.sql` (backfills `client_id = 'admin'` on existing endpoints), then `migrations/0002_geofence_actions.sql` (adds the `geofence_actions` table).

## Configure the phone

In the OwnTracks app (iOS/Android):

1. Settings → Mode → **HTTP**
2. URL: `https://<your-worker>.workers.dev/pub`
3. Authentication: HTTP Basic with `OWTRACKS_USER` / `OWTRACKS_PASSWORD`
4. Publish manually once — `GET /admin/locations` should show the row.

Only `_type: "location"` payloads are stored; everything else gets `200 []`.

## Connect an MCP client

Point the client at `https://<your-worker>.workers.dev/mcp`. It will run the OAuth flow; the `/authorize` consent page requires the admin password login. Approved grants issue bearer tokens (1 h access, 30 d initial/idle refresh lifetime).

### OAuth client authentication and refresh troubleshooting

Client registration (`POST /oauth/register`) returns `client_id`, the effective
`token_endpoint_auth_method`, and, for confidential clients, a `client_secret`.
The client must persist these together and use the same identity for both code
exchange and refresh at `/oauth/token`. If the method is omitted at registration,
the provider defaults to `client_secret_basic`, **not** `none`.

- `client_secret_basic`: send the issued ID and secret as HTTP Basic credentials
  (form-encode each component before base64 encoding).
- `client_secret_post`: send the issued ID and secret in the form body.
- `none`: public client, no secret; authorization requires S256 PKCE.

The Worker tolerates switching between Basic and POST **only for confidential
clients supplying a nonempty secret**: it translates the transport to the client's
registered method, then lets the OAuth provider validate the original secret,
PKCE/code, refresh token, client binding, resource, scopes, expiry and revocation.
It does not change stored registrations, bypass secrets, downgrade a confidential
client to `none`, or strip credentials from a public client. Malformed, repeated or
mixed authentication is left to the provider to reject.

In provider **1.2.3** (also verified in the deployed Worker bundle), the exact error
`invalid_client` / `Client authentication failed` comes from
`parseTokenEndpointRequest` with reason `token_endpoint_auth_method_mismatch`:
authentication fails **before** refresh-token validation. Explicit registrations
enforce their method; the library's built-in Basic/POST compatibility only covers
legacy/implicit registrations. A wrong secret, unknown client and expired refresh
token have different descriptions/reasons. This establishes the method-mismatch
failure class, but not the particular registered/presented pair in an individual
incident without its client configuration or logs.

The application's structured OAuth diagnostics include only `code`, `status`,
`category`, `reason` and allowlisted registered/presented methods. Never paste
request bodies, Authorization headers, tokens, secrets or KV client records into
logs or support messages.

#### CIMD outages and refresh lifetime

Like render-html, this Worker uses `@cloudflare/workers-oauth-provider` 1.2.3, but
**CIMD is not enabled here**: `clientIdMetadataDocumentEnabled` defaults to false,
the Worker has no `global_fetch_strictly_public` flag, and public discovery reports
`client_id_metadata_document_supported: false`. Clients currently use DCR and KV
registrations, not URL-fetched client metadata. This change preserves that setup;
enabling CIMD separately requires both the provider option and the SSRF-protecting
compatibility flag.

For any CIMD-enabled use of the OAuth wrapper, only the provider's
`client-id-metadata-document` / `metadata_resolution_failed` error is translated
from `401 invalid_client` into **`503 temporarily_unavailable`**, with
`Retry-After: 30` and `Cache-Control: no-store`. The same response is returned for
`CimdFetchError` during the early compatibility lookup or authorization/consent,
instead of a 500/400. Retry later with the **same credentials**. Failed resolution
does not consume a code, rotate a refresh token, or renew a grant. No stale
metadata or unverified client is accepted. The provider groups fetch errors and
invalid metadata under this reason, so all remain unavailable until a valid
document can be resolved. Genuine unknown clients, wrong secrets and method
mismatches remain authentication errors; unrelated failures are not masked.

`fetchOAuth` explicitly defaults both `refreshTokenTTL` and `refreshTokenIdleTTL`
to **2,592,000 seconds (30 days)**. A new grant initially expires in 30 days; each
successful refresh moves expiry to 30 days after that refresh, rather than keeping
an absolute 30-day ceiling from authorization. Access tokens remain one hour, and
rotation/replay protection, client binding, scope limits and revocation remain
unchanged. Existing live grants adopt rolling expiry on their next successful
refresh. Expired/deleted grants are not revived, and failed authentication does
not extend the idle window. The provider's renewable 90-day DCR registrations are
unchanged.

After deploying, an existing confidential client's valid credentials can refresh
using either transport; no KV/D1 migration or new Worker secret is needed. If the
client omitted/lost its issued secret, restore it **in the MCP client's OAuth
credential store**, not in `ADMIN_PASSWORD` or a made-up Worker variable. If it
cannot be recovered, reconnect/re-register and approve OAuth again. Public clients
must register with `token_endpoint_auth_method: "none"` and must not send a secret.
Retain the replacement refresh token after every successful refresh. Idle-expired or
revoked grants also require reauthorization; this compatibility does not revive
them. Keep the production `OAUTH_KV` namespace unchanged across deployments.

Re-registering normally creates a new `client_id`; existing geofences and webhooks
remain owned by the old ID and must be reviewed/recreated for the new client (do
not silently transfer ownership). The production client's stored credentials and
refresh request were not accessible during this investigation, so a live refresh
and `get_current_location` must still be checked after deployment/reconnection.

### Tools

| Tool | Purpose |
|---|---|
| `get_current_location` | Latest recorded location (lat/lon/acc/batt/timestamp/age) |
| `get_location_history` | Recent history, newest first (≤ `HISTORY_SIZE`) |
| `list_webhooks` | Registered webhook endpoints (id, label, url — never tokens) |
| `register_geofence` | `name`, `lat`, `lon`, `radius_m`, `events` + either `webhook_id` (reuse a registered endpoint) or `webhook_url` + optional `webhook_token` (deduplicated into the registry) → `{id, initial_state, webhook}` |
| `list_geofences` | Caller's subscriptions + state + last delivery |
| `update_geofence` / `unregister_geofence` | Patch / delete a subscription (owner client only) |
| `create_geofence_action` | Attach a reminder action to a geofence: `trigger` (`enter`/`exit`), `message`, `schedule_type` (`once`/`always`/`until`), `expires_at` (unix seconds or ISO 8601, required for `until`) |
| `list_geofence_actions` | List actions on the caller's geofences (optionally one geofence or one status) |
| `delete_geofence_action` | Delete an action (owner client only) |
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
  "actions": [{"id": "…", "type": "remind", "message": "check the door", "schedule_type": "once"}],
  "timestamp": 0
}
```

The payload is neutral and data-first: no generated prose — `actions` carries the reminder `message` of every action this transition consumed (empty when none matched).

`Authorization: Bearer <token>` is sent when the endpoint has a token. To reach a **Poke** agent, create a trigger with Poke's `create_webhook` and register its `webhookUrl` + `webhookToken` as an endpoint. Any other HTTPS endpoint works too.

Semantics: the first location observed after registration sets the baseline state and does **not** fire events **or actions** (use `initial_state` instead); subsequent inside↔outside flips fire once each — each upload's store + transitions + action consumption + eval marker commit in one atomic D1 batch, so overlapping uploads can't double-fire or desync "current" from geofence state. Actions: `once` transitions to `completed` inside that same batch so it can never execute twice, `always` fires on every matching transition, and `until` fires while `now < expires_at` (overdue rows are marked `expired`). Uploads are ordered by the device-reported `tst`: an out-of-order fix (queued upload arriving late) is stored in history but doesn't become "current" or move geofence state, and an exact replay (same tst+coords) is dropped before storage. Editing a geofence's circle re-baselines `last_state` from the latest location, so boundary changes never fire movement events. One delivery attempt per event, 5 s timeout, every attempt logged to the `deliveries` table (last 200 kept).

## Admin app

`https://<your-worker>.workers.dev/admin` — sign in with `ADMIN_PASSWORD` (HMAC session cookie, 7 days, `__Host-` `Secure` `SameSite=Lax`). Login attempts are throttled per source IP (5 failures → 15 min lockout via KV), and all POSTs check `Origin` against the request host. Dashboard, recent locations, **webhook endpoint registry**, geofence CRUD + test-fire, delivery log, and a `/admin/setup` page with copy-paste instructions. A webhook can't be deleted while geofences still reference it.

## Notes / limits

- Workers Free: 100k requests/day, 10 ms CPU, 50 subrequests/invocation (each fired geofence webhook = 1 subrequest).
- D1 Free: 100k rows written/day, 5 GB — a 1/minute tracker uses ~3k writes/day.
- KV (OAuth state): reads are plentiful; writes are a handful per grant.
- `resourceMetadata.resource` is derived per-request from the URL origin, so dev (`http://localhost`) and any custom domain both work; set `PUBLIC_BASE_URL` to pin a canonical origin.
- Secrets never go in `wrangler.jsonc` vars; `.dev.vars` is gitignored.

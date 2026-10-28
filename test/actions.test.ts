import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleIngest } from "../src/ingest";
import {
  createGeofence,
  createGeofenceAction,
  createWebhook,
  getGeofenceAction,
  listGeofenceActions,
} from "../src/db";
import {
  FakeD1,
  makeEnv,
  makeCtx,
  basicAuth,
  locationBody,
} from "./helpers";

const URL_ = "https://worker.example/pub";
const AUTH = basicAuth("owntracks", "test-owntracks-password");

function req(body: string): Request {
  return new Request(URL_, {
    method: "POST",
    body,
    headers: { Authorization: AUTH },
  });
}

function lastPayload(fetchSpy: ReturnType<typeof vi.fn>) {
  const calls = fetchSpy.mock.calls;
  return JSON.parse(String(calls[calls.length - 1]![1]!.body));
}

describe("geofence actions", () => {
  let db: FakeD1;
  let env: ReturnType<typeof makeEnv>;
  let ctx: ReturnType<typeof makeCtx>;
  const fetchSpy = vi.fn();
  let fenceId: string;
  let tst = 2000000;

  const post = (lat: number, lon: number, t?: number) =>
    handleIngest(req(locationBody({ lat, lon, tst: t ?? ++tst })), env, ctx);

  beforeEach(async () => {
    db = new FakeD1();
    env = makeEnv(db);
    ctx = makeCtx();
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const hook = await createWebhook(env.DB, {
      client_id: "test-client",
      label: "test",
      url: "https://hooks.example/abc",
      token: null,
    });
    const fence = await createGeofence(env.DB, {
      client_id: "test-client",
      name: "home",
      lat: 37.7749,
      lon: -122.4194,
      radius_m: 500,
      on_enter: true,
      on_exit: true,
      webhook_id: hook.id,
    });
    fenceId = fence.id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not fire actions on baseline fix establishment", async () => {
    const action = await createGeofenceAction(env.DB, {
      geofence_id: fenceId,
      trigger: "enter",
      message: "check the door",
      schedule_type: "once",
      expires_at: null,
    });
    await post(37.7749, -122.4194); // first observation inside -> baseline, no fire
    await Promise.all(ctx.awaited);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await getGeofenceAction(env.DB, action.id))!.status).toBe("active");
  });

  it("fires a once action on the first transition and consumes it atomically", async () => {
    const action = await createGeofenceAction(env.DB, {
      geofence_id: fenceId,
      trigger: "enter",
      message: "check the door",
      schedule_type: "once",
      expires_at: null,
    });
    await post(37.9, -122.4194); // baseline outside
    await post(37.7749, -122.4194); // enter -> fires
    await Promise.all(ctx.awaited);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const payload = lastPayload(fetchSpy);
    expect(payload.actions).toEqual([
      {
        id: action.id,
        type: "remind",
        message: "check the door",
        schedule_type: "once",
      },
    ]);
    const row = await getGeofenceAction(env.DB, action.id);
    expect(row!.status).toBe("completed");
    expect(row!.last_triggered_at).not.toBeNull();

    await post(37.9, -122.4194); // exit
    await post(37.7749, -122.4194); // enter again -> no action payload
    await Promise.all(ctx.awaited);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(lastPayload(fetchSpy).actions).toEqual([]);
  });

  it("fires an always action on every matching transition", async () => {
    const action = await createGeofenceAction(env.DB, {
      geofence_id: fenceId,
      trigger: "exit",
      message: "say bye",
      schedule_type: "always",
      expires_at: null,
    });
    await post(37.7749, -122.4194); // baseline inside
    await post(37.9, -122.4194); // exit #1
    await post(37.7749, -122.4194); // enter (other trigger)
    await post(37.9, -122.4194); // exit #2
    await Promise.all(ctx.awaited);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const exits = fetchSpy.mock.calls.filter(
      (c) => JSON.parse(String(c[1]!.body)).event === "exit",
    );
    expect(exits).toHaveLength(2);
    for (const c of exits) {
      expect(JSON.parse(String(c[1]!.body)).actions[0].id).toBe(action.id);
    }
    const row = await getGeofenceAction(env.DB, action.id);
    expect(row!.status).toBe("active");
    expect(row!.last_triggered_at).not.toBeNull();
  });

  it("fires an until action before expiry and expires it afterwards", async () => {
    const now = Math.floor(Date.now() / 1000);
    const live = await createGeofenceAction(env.DB, {
      geofence_id: fenceId,
      trigger: "enter",
      message: "still valid",
      schedule_type: "until",
      expires_at: now + 3600,
    });
    const dead = await createGeofenceAction(env.DB, {
      geofence_id: fenceId,
      trigger: "enter",
      message: "stale",
      schedule_type: "until",
      expires_at: now - 1,
    });
    await post(37.9, -122.4194); // baseline outside
    await post(37.7749, -122.4194); // enter
    await Promise.all(ctx.awaited);
    const payload = lastPayload(fetchSpy);
    expect(payload.actions).toHaveLength(1);
    expect(payload.actions[0].id).toBe(live.id);
    expect((await getGeofenceAction(env.DB, live.id))!.status).toBe("active");
    expect((await getGeofenceAction(env.DB, dead.id))!.status).toBe("expired");
    // listGeofenceActions also lazily expires overdue 'until' rows
    const remaining = await listGeofenceActions(env.DB, {
      geofenceId: fenceId,
      status: "active",
    });
    expect(remaining.map((a) => a.id)).toEqual([live.id]);
  });

  it("sends a neutral, data-first payload with no prose message", async () => {
    await post(37.9, -122.4194); // baseline outside
    await post(37.7749, -122.4194); // enter
    await Promise.all(ctx.awaited);
    const payload = lastPayload(fetchSpy);
    expect(payload).toMatchObject({
      event: "enter",
      geofence: {
        id: fenceId,
        name: "home",
        lat: 37.7749,
        lon: -122.4194,
        radius_m: 500,
      },
      location: {
        lat: 37.7749,
        lon: -122.4194,
        acc: 5,
        device: "JJ",
      },
      actions: [],
    });
    expect(payload.location.tst).toBeGreaterThan(0);
    expect(payload.timestamp).toBeGreaterThan(0);
    expect(payload).not.toHaveProperty("message");
    expect(JSON.stringify(payload)).not.toContain("Jun");
  });
});

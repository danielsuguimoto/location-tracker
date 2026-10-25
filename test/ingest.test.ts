import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleIngest } from "../src/ingest";
import { createGeofence, createWebhook, listLocations, getGeofence, getOrCreateWebhook, latestLocation } from "../src/db";
import {
  FakeD1,
  makeEnv,
  makeCtx,
  basicAuth,
  locationBody,
} from "./helpers";

const URL_ = "https://worker.example/pub";

function req(body: string, auth?: string): Request {
  return new Request(URL_, {
    method: "POST",
    body,
    headers: auth ? { Authorization: auth } : {},
  });
}

describe("POST /pub", () => {
  let db: FakeD1;
  let env: ReturnType<typeof makeEnv>;
  let ctx: ReturnType<typeof makeCtx>;
  const fetchSpy = vi.fn();

  beforeEach(() => {
    db = new FakeD1();
    env = makeEnv(db);
    ctx = makeCtx();
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects GET and missing/wrong credentials", async () => {
    expect(
      (await handleIngest(new Request(URL_), env, ctx)).status,
    ).toBe(405);
    expect((await handleIngest(req(locationBody()), env, ctx)).status).toBe(
      401,
    );
    expect(
      (
        await handleIngest(
          req(locationBody(), basicAuth("owntracks", "wrong")),
          env,
          ctx,
        )
      ).status,
    ).toBe(401);
  });

  it("stores a location update and returns []", async () => {
    const res = await handleIngest(
      req(locationBody(), basicAuth("owntracks", "test-owntracks-password")),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    const rows = await listLocations(env.DB, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.device).toBe("JJ");
  });

  it("ignores empty bodies and non-location payloads", async () => {
    const auth = basicAuth("owntracks", "test-owntracks-password");
    for (const body of ["", '{"_type":"transition","event":"enter"}', "not json"]) {
      const res = await handleIngest(req(body, auth), env, ctx);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    }
    expect(await listLocations(env.DB, 10)).toHaveLength(0);
  });

  it("prunes history to HISTORY_SIZE", async () => {
    env.HISTORY_SIZE = "3";
    const auth = basicAuth("owntracks", "test-owntracks-password");
    for (let i = 0; i < 6; i++) {
      await handleIngest(
        req(locationBody({ tst: 1000 + i }), auth),
        env,
        ctx,
      );
    }
    const rows = await listLocations(env.DB, 10);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.tst).toBe(1005);
  });

  it("fires webhook on enter/exit transitions, not on first observation", async () => {
    const auth = basicAuth("owntracks", "test-owntracks-password");
    const hook = await createWebhook(env.DB, {
      client_id: "test-client",
      label: "test",
      url: "https://hooks.example/abc",
      token: "tok123",
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

    let tst = 2000000;
    const post = (lat: number, lon: number) =>
      handleIngest(req(locationBody({ lat, lon, tst: ++tst }), auth), env, ctx);

    await post(37.7749, -122.4194); // first observation inside -> no fire
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await getGeofence(env.DB, fence.id))!.last_state).toBe("inside");

    await post(37.8, -122.4194); // leave -> exit
    await Promise.all(ctx.awaited);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://hooks.example/abc");
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok123",
    );
    expect(JSON.parse(String(init!.body)).event).toBe("exit");

    await post(37.7749, -122.4194); // return -> enter
    await Promise.all(ctx.awaited);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String(fetchSpy.mock.calls[1]![1]!.body)).event,
    ).toBe("enter");
  });

  it("respects on_enter/on_exit filters", async () => {
    const auth = basicAuth("owntracks", "test-owntracks-password");
    const hook = await createWebhook(env.DB, {
      client_id: "test-client",
      label: "test",
      url: "https://hooks.example/abc",
      token: null,
    });
    await createGeofence(env.DB, {
      client_id: "test-client",
      name: "office",
      lat: 37.7749,
      lon: -122.4194,
      radius_m: 500,
      on_enter: false,
      on_exit: true,
      webhook_id: hook.id,
    });
    let tst = 2000000;
    const post = (lat: number, lon: number) =>
      handleIngest(req(locationBody({ lat, lon, tst: ++tst }), auth), env, ctx);
    await post(37.7749, -122.4194); // baseline inside
    await post(37.8, -122.4194); // exit fires
    await Promise.all(ctx.awaited);
    await post(37.7749, -122.4194); // enter suppressed
    await Promise.all(ctx.awaited);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)).event,
    ).toBe("exit");
  });

  it("getOrCreateWebhook dedupes per client on url+token", async () => {
    const a = await getOrCreateWebhook(env.DB, "c1", "https://hooks.example/x", "t1");
    const b = await getOrCreateWebhook(env.DB, "c1", "https://hooks.example/x", "t1");
    const c = await getOrCreateWebhook(env.DB, "c1", "https://hooks.example/x", null);
    const d = await getOrCreateWebhook(env.DB, "c1", "https://hooks.example/x", null);
    const other = await getOrCreateWebhook(env.DB, "c2", "https://hooks.example/x", "t1");
    expect(a.id).toBe(b.id);
    expect(c.id).toBe(d.id);
    expect(a.id).not.toBe(c.id);
    expect(other.id).not.toBe(a.id);
  });

  it("stores stale uploads but does not move state or fire", async () => {
    const auth = basicAuth("owntracks", "test-owntracks-password");
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
    const post = (lat: number, lon: number, tst: number) =>
      handleIngest(req(locationBody({ lat, lon, tst }), auth), env, ctx);

    await post(37.7749, -122.4194, 3000); // baseline inside at tst=3000
    // Queued older fix outside replays late: stored, but not "current".
    await post(37.9, -122.4194, 1000);
    const fenceRow = await getGeofence(env.DB, fence.id);
    expect(fenceRow!.last_state).toBe("inside");
    const latest = await latestLocation(env.DB);
    expect(latest!.tst).toBe(3000);
    expect(await listLocations(env.DB, 10)).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the newer fix when a stale upload fills history", async () => {
    env.HISTORY_SIZE = "1";
    const auth = basicAuth("owntracks", "test-owntracks-password");
    const post = (lat: number, lon: number, tst: number) =>
      handleIngest(req(locationBody({ lat, lon, tst }), auth), env, ctx);
    await post(37.7749, -122.4194, 3000);
    await post(37.9, -122.4194, 1000); // stale replay evicts itself
    const latest = await latestLocation(env.DB);
    expect(latest!.tst).toBe(3000);
    expect(latest!.lat).toBe(37.7749);
  });

  it("evaluates a distinct fix sharing the same tst, skips exact replays", async () => {
    const auth = basicAuth("owntracks", "test-owntracks-password");
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
    const post = (lat: number, lon: number, tst: number) =>
      handleIngest(req(locationBody({ lat, lon, tst }), auth), env, ctx);

    await post(37.9, -122.4194, 2000); // baseline outside
    await post(37.7749, -122.4194, 2000); // distinct fix, same second -> enter
    await Promise.all(ctx.awaited);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)).event,
    ).toBe("enter");
    expect((await getGeofence(env.DB, fence.id))!.last_state).toBe("inside");

    await post(37.9, -122.4194, 2000); // exact replay of the outside fix
    await Promise.all(ctx.awaited);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await getGeofence(env.DB, fence.id))!.last_state).toBe("inside");
  });

  it("ignores out-of-range coordinates and non-positive tst", async () => {
    const auth = basicAuth("owntracks", "test-owntracks-password");
    for (const body of [
      locationBody({ lat: 91 }),
      locationBody({ lon: -181 }),
      locationBody({ tst: 0 }),
      locationBody({ tst: -5 }),
    ]) {
      const res = await handleIngest(req(body, auth), env, ctx);
      expect(res.status).toBe(200);
    }
    expect(await listLocations(env.DB, 10)).toHaveLength(0);
  });
});

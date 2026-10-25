export interface LocationUpdate {
  lat: number;
  lon: number;
  acc: number | null;
  alt: number | null;
  vel: number | null;
  cog: number | null;
  batt: number | null;
  trigger: string | null;
  tst: number;
  device: string | null;
  raw: string;
}

export type ParsedPayload =
  | { kind: "location"; location: LocationUpdate }
  | { kind: "empty" }
  | { kind: "ignored" };

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseOwnTracksPayload(body: string): ParsedPayload {
  if (body.trim().length === 0) return { kind: "empty" };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body);
  } catch {
    return { kind: "ignored" };
  }
  if (obj === null || typeof obj !== "object" || obj._type !== "location") {
    return { kind: "ignored" };
  }
  const lat = num(obj.lat);
  const lon = num(obj.lon);
  const tst = num(obj.tst);
  if (lat === null || lon === null || tst === null) return { kind: "ignored" };
  const device =
    typeof obj.tid === "string" && obj.tid
      ? obj.tid
      : typeof obj.topic === "string"
        ? obj.topic
        : null;
  return {
    kind: "location",
    location: {
      lat,
      lon,
      acc: num(obj.acc),
      alt: num(obj.alt),
      vel: num(obj.vel),
      cog: num(obj.cog),
      batt: num(obj.batt),
      trigger: typeof obj.t === "string" ? obj.t : null,
      tst,
      device,
      raw: body.slice(0, 8192),
    },
  };
}

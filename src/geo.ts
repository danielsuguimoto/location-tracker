const EARTH_RADIUS_M = 6371000;

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export type GeofenceState = "inside" | "outside";
export type GeofenceEvent = "enter" | "exit";

export function transitionEvent(
  previous: GeofenceState | null,
  current: GeofenceState,
): GeofenceEvent | null {
  if (previous === null || previous === current) return null;
  return current === "inside" ? "enter" : "exit";
}

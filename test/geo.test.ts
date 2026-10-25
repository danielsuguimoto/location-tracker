import { describe, it, expect } from "vitest";
import { haversineMeters, transitionEvent } from "../src/geo";

describe("haversineMeters", () => {
  it("returns 0 for identical points", () => {
    expect(haversineMeters(37.7749, -122.4194, 37.7749, -122.4194)).toBe(0);
  });

  it("computes ~111km per degree of latitude", () => {
    const d = haversineMeters(0, 0, 1, 0);
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112000);
  });

  it("computes a known SF→NYC distance (~4130km)", () => {
    const d = haversineMeters(37.7749, -122.4194, 40.7128, -74.006);
    expect(d).toBeGreaterThan(4_000_000);
    expect(d).toBeLessThan(4_300_000);
  });
});

describe("transitionEvent", () => {
  it("does not fire on first observation", () => {
    expect(transitionEvent(null, "inside")).toBeNull();
    expect(transitionEvent(null, "outside")).toBeNull();
  });

  it("fires enter on outside→inside and exit on inside→outside", () => {
    expect(transitionEvent("outside", "inside")).toBe("enter");
    expect(transitionEvent("inside", "outside")).toBe("exit");
  });

  it("does not fire when state is unchanged", () => {
    expect(transitionEvent("inside", "inside")).toBeNull();
    expect(transitionEvent("outside", "outside")).toBeNull();
  });
});

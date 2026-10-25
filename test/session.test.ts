import { describe, it, expect } from "vitest";
import {
  signSessionValue,
  verifySession,
  sessionCookieHeader,
  checkPassword,
} from "../src/session";

const SECRET = "test-admin-password";
const NOW = 1_700_000_000;

function cookieFor(value: string): string {
  return `__Host-lt=${value}; Other=1`;
}

describe("session cookie", () => {
  it("round-trips a signed session", async () => {
    const value = await signSessionValue(SECRET, NOW);
    expect(await verifySession(cookieFor(value), SECRET, NOW + 60)).toBe(
      true,
    );
  });

  it("rejects expired sessions", async () => {
    const value = await signSessionValue(SECRET, NOW);
    expect(
      await verifySession(cookieFor(value), SECRET, NOW + 8 * 24 * 3600),
    ).toBe(false);
  });

  it("rejects tampered or wrong-secret sessions", async () => {
    const value = await signSessionValue(SECRET, NOW);
    const tampered = `${value.slice(0, -4)}AAAA`;
    expect(await verifySession(cookieFor(tampered), SECRET, NOW + 60)).toBe(
      false,
    );
    expect(await verifySession(cookieFor(value), "other", NOW + 60)).toBe(
      false,
    );
    expect(await verifySession(null, SECRET, NOW)).toBe(false);
    expect(await verifySession("", SECRET, NOW)).toBe(false);
  });

  it("emits a hardened cookie header", () => {
    const h = sessionCookieHeader("v");
    expect(h).toContain("__Host-lt=v");
    expect(h).toContain("HttpOnly");
    expect(h).toContain("Secure");
    expect(h).toContain("SameSite=Lax");
  });
});

describe("checkPassword", () => {
  it("accepts the correct password only", async () => {
    expect(await checkPassword(SECRET, SECRET)).toBe(true);
    expect(await checkPassword("nope", SECRET)).toBe(false);
    expect(await checkPassword("", SECRET)).toBe(false);
  });
});

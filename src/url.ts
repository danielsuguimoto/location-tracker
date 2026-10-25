const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
]);

const PRIVATE_CIDRS: [number, number][] = [
  [0x7f000000, 0xff000000], // 127.0.0.0/8 loopback
  [0x0a000000, 0xff000000], // 10.0.0.0/8
  [0xac100000, 0xfff00000], // 172.16.0.0/12
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16 link-local (cloud metadata)
  [0x00000000, 0xff000000], // 0.0.0.0/8
];

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return false;
  const [a, b, c, d] = nums as [number, number, number, number];
  const ip = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  return PRIVATE_CIDRS.some(([net, mask]) => (ip & mask) === net);
}

function isBlockedIpv6(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "::1" ||
    h === "::" ||
    h === "0:0:0:0:0:0:0:1" ||
    h.startsWith("fe80:") ||
    h.startsWith("fc") ||
    h.startsWith("fd") ||
    h === "[::1]" ||
    h === "[::]"
  );
}

export function webhookUrlError(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "invalid URL";
  }
  if (parsed.protocol !== "https:") return "url must use https";
  const host = parsed.hostname.toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    isPrivateIpv4(host) ||
    isBlockedIpv6(host)
  ) {
    return "url must resolve to a public host";
  }
  return null;
}

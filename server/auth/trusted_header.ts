/**
 * Sign-in by a trusted reverse proxy (ARCHITECTURE.md §14.1, D70): Authelia, an Authentik outpost or
 * oauth2-proxy signs people in and passes the user (and their groups) in request headers. The headers are
 * believed only from the configured proxy addresses, as the connection's own peer: never from
 * X-Forwarded-For, which any client can send. Only members of one group get in. Pure.
 */

/** One address or network, parsed: IPv4 as 4 bytes, IPv6 as 16. */
interface Network {
  bytes: Uint8Array;
  prefix: number;
}

function parseIpv4(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (const [i, p] of parts.entries()) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    out[i] = Number(p);
  }
  return out;
}

function parseIpv6(s: string): Uint8Array | null {
  // An embedded IPv4 tail ("::ffff:10.0.0.5") becomes two groups.
  let text = s;
  const v4 = /:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const b = parseIpv4(v4[1]);
    if (!b) return null;
    text = `${text.slice(0, v4.index)}:${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const out = new Uint8Array(16);
  for (const [i, g] of groups.entries()) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

/** An address as bytes; an IPv4-mapped IPv6 address ("::ffff:10.0.0.5") as its IPv4 bytes. */
export function parseIp(s: string): Uint8Array | null {
  const t = s.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v4 = parseIpv4(t);
  if (v4) return v4;
  const v6 = parseIpv6(t);
  if (!v6) return null;
  const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  return mapped ? v6.slice(12) : v6;
}

/** "10.0.0.5, 172.16.0.0/12, fd00::/8": throws on anything that is not an address or network. */
export function parseProxies(list: string): Network[] {
  return list.split(/[\s,]+/).filter(Boolean).map((entry) => {
    const [addr, bits] = entry.split("/");
    const bytes = parseIp(addr);
    if (!bytes) throw new Error(`"${entry}" is not an IP address or network`);
    const max = bytes.length * 8;
    const prefix = bits === undefined ? max : Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (bits !== undefined && !/^\d+$/.test(bits))) {
      throw new Error(`"${entry}" has an invalid prefix length`);
    }
    return { bytes, prefix };
  });
}

/** Whether the connection's peer is one of the trusted proxies. */
export function fromTrustedProxy(peer: string, proxies: Network[]): boolean {
  const ip = parseIp(peer);
  if (!ip) return false;
  return proxies.some((n) => {
    if (n.bytes.length !== ip.length) return false;
    for (let bit = 0; bit < n.prefix; bit++) {
      const mask = 0x80 >> (bit % 8);
      if ((n.bytes[bit >> 3] & mask) !== (ip[bit >> 3] & mask)) return false;
    }
    return true;
  });
}

/** "admins, tagmonia" or "admins|tagmonia" (proxies differ): whether `group` is among them, ignoring case. */
export function headerInGroup(value: string | undefined, group: string): boolean {
  if (!value) return false;
  const want = group.replace(/^\//, "").toLowerCase();
  return value.split(/[,|]/).some((g) => g.trim().replace(/^\//, "").toLowerCase() === want);
}

export interface TrustedHeaderSettings {
  userHeader: string;
  groupsHeader: string;
  group: string;
  proxies: Network[];
}

/**
 * Who the proxy says the request is from: a name to sign in, "refused" (not in the group), or null when the
 * request carries no user header or does not come from a trusted proxy (then the headers mean nothing).
 */
export function trustedUser(
  s: TrustedHeaderSettings,
  peer: string,
  header: (name: string) => string | undefined,
): { name: string } | "refused" | null {
  if (!fromTrustedProxy(peer, s.proxies)) return null;
  const name = header(s.userHeader)?.trim();
  if (!name || name.length > 200 || /[\p{Cc}]/u.test(name)) return null;
  return headerInGroup(header(s.groupsHeader), s.group) ? { name } : "refused";
}

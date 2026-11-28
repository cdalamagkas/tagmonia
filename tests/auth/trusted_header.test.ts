/** Sign-in by a trusted reverse proxy (D70): which addresses count, and what the headers must say. */
import { assertEquals, assertThrows } from "@std/assert";
import {
  fromTrustedProxy,
  headerInGroup,
  parseIp,
  parseProxies,
  trustedUser,
} from "../../server/auth/trusted_header.ts";

Deno.test("proxies: single addresses and networks, IPv4 and IPv6, IPv4-mapped IPv6 as IPv4", () => {
  const p = parseProxies("10.0.0.5, 172.16.0.0/12 fd00::/8");
  assertEquals(fromTrustedProxy("10.0.0.5", p), true);
  assertEquals(fromTrustedProxy("10.0.0.6", p), false);
  assertEquals(fromTrustedProxy("172.20.1.9", p), true, "inside 172.16.0.0/12");
  assertEquals(fromTrustedProxy("172.32.0.1", p), false);
  assertEquals(fromTrustedProxy("::ffff:10.0.0.5", p), true, "how dual-stack servers report IPv4 peers");
  assertEquals(fromTrustedProxy("fd12:3456::1", p), true);
  assertEquals(fromTrustedProxy("fe80::1", p), false);
  assertEquals(fromTrustedProxy("unknown", p), false);
  assertEquals(parseIp("::1"), new Uint8Array([...Array(15).fill(0), 1]));
  for (const bad of ["10.0.0.256", "10.0.0.0/33", "example.com", "10.0.0.0/-1", "1::2::3"]) {
    assertThrows(() => parseProxies(bad), Error, undefined, bad);
  }
});

Deno.test("groups header: comma or pipe separated, any case, a leading slash ignored", () => {
  assertEquals(headerInGroup("admins, Tagmonia", "tagmonia"), true);
  assertEquals(headerInGroup("admins|/tagmonia", "tagmonia"), true);
  assertEquals(headerInGroup("tagmonia-users", "tagmonia"), false);
  assertEquals(headerInGroup(undefined, "tagmonia"), false);
});

Deno.test("the headers count only from a proxy; a non-member is refused; no user header, nothing", () => {
  const s = {
    userHeader: "Remote-User",
    groupsHeader: "Remote-Groups",
    group: "tagmonia",
    proxies: parseProxies("10.0.0.5"),
  };
  const h = (headers: Record<string, string>) => (n: string) => headers[n];
  const ok = h({ "Remote-User": "alice", "Remote-Groups": "tagmonia" });
  assertEquals(trustedUser(s, "10.0.0.5", ok), { name: "alice" });
  assertEquals(trustedUser(s, "192.168.1.50", ok), null, "anyone can send the header; only the proxy is believed");
  assertEquals(trustedUser(s, "10.0.0.5", h({ "Remote-User": "eve", "Remote-Groups": "family" })), "refused");
  assertEquals(trustedUser(s, "10.0.0.5", h({ "Remote-Groups": "tagmonia" })), null);
  assertEquals(trustedUser(s, "10.0.0.5", h({ "Remote-User": "a\u0000b", "Remote-Groups": "tagmonia" })), null);
});

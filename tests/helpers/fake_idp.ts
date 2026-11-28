/** A fake OpenID provider behind an injected fetch (D69): discovery, token and user info; nothing on the network. */
export const ISSUER = "https://idp.test/application/o/tagmonia/";

export interface FakeUser {
  sub: string;
  preferred_username?: string;
  /** In the ID token's groups claim; `inUserInfo` moves them to the user info response. */
  groups?: string[];
  inUserInfo?: boolean;
}

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export function fakeIdp(clientId = "tagmonia") {
  const state = {
    user: { sub: "u1", preferred_username: "alice", groups: ["tagmonia"] } as FakeUser,
    nonce: "",
    seen: [] as string[],
  };
  const respond = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = new URL(String(input));
    state.seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: "https://idp.test/authorize",
        token_endpoint: "https://idp.test/token",
        userinfo_endpoint: "https://idp.test/userinfo",
        jwks_uri: "https://idp.test/jwks",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url.pathname === "/token") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (body.get("code") !== "good-code" || !body.get("code_verifier")) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      const now = Math.floor(Date.now() / 1000);
      const { inUserInfo, groups, ...claims } = state.user;
      const idToken = [
        b64({ alg: "RS256", typ: "JWT" }),
        b64({
          iss: ISSUER,
          aud: clientId,
          iat: now,
          exp: now + 300,
          nonce: state.nonce,
          ...claims,
          ...(inUserInfo ? {} : { groups }),
        }),
        "c2lnbmF0dXJl",
      ].join(".");
      return Response.json({ access_token: "at", token_type: "Bearer", id_token: idToken, expires_in: 300 });
    }
    if (url.pathname === "/userinfo") {
      return Response.json({ sub: state.user.sub, groups: state.user.inUserInfo ? state.user.groups : undefined });
    }
    return new Response("not found", { status: 404 });
  };
  const fetch: typeof globalThis.fetch = (input, init) => Promise.resolve(respond(input, init));
  return { fetch, state };
}

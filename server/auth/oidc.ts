/**
 * Single sign-on with OpenID Connect (ARCHITECTURE.md §14.1, D69): the authorization code flow with PKCE,
 * state and nonce, through `oauth4webapi`. Only members of the configured group get in. Configured from the
 * environment only, so nobody signed in can change who may sign in.
 *
 * The pending sign-ins (state, nonce, PKCE verifier) are kept in memory for ten minutes, keyed by a random value
 * in a short-lived cookie: a callback from another browser, or replayed, finds nothing and is refused.
 */
import * as oauth from "oauth4webapi";

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  group: string;
  groupsClaim: string;
  scopes: string;
  /** Where the provider sends the browser back: <public URL>/api/auth/oidc/callback. */
  redirectUri: string;
}

/** Why a sign-in was refused, as the sign-in page words it; never contains a token or a secret. */
export class OidcError extends Error {
  override name = "OidcError";
  constructor(readonly code: "expired" | "group" | "provider", message: string) {
    super(message);
  }
}

export interface OidcIdentity {
  /** issuer + subject: stable, and unique across providers. */
  externalId: string;
  /** preferred_username, else name, else email, else the subject. */
  name: string;
}

const PENDING_MS = 10 * 60_000;

/** Whether the groups claim (a list, or one value) holds the group; "/tagmonia" (Keycloak's paths) counts too. */
export function inGroup(claim: unknown, group: string): boolean {
  const values = Array.isArray(claim) ? claim : typeof claim === "string" ? [claim] : [];
  const want = group.replace(/^\//, "").toLowerCase();
  return values.some((v) => typeof v === "string" && v.replace(/^\//, "").toLowerCase() === want);
}

export class OidcLogin {
  readonly #s: OidcSettings;
  readonly #opts: { fetch?: typeof fetch; now: () => number; insecure: boolean };
  #as: Promise<oauth.AuthorizationServer> | null = null;
  readonly #pending = new Map<string, { state: string; nonce: string; verifier: string; expires: number }>();

  /** `insecure`: tests only, for a provider on http://localhost. */
  constructor(settings: OidcSettings, opts: { fetch?: typeof fetch; now?: () => number; insecure?: boolean } = {}) {
    this.#s = settings;
    this.#opts = { fetch: opts.fetch, now: opts.now ?? Date.now, insecure: opts.insecure ?? false };
  }

  /** Request options for every call: the injected fetch (tests), a timeout. Each call has its own option type. */
  #http<T>(): T {
    return {
      ...(this.#opts.fetch ? { [oauth.customFetch]: this.#opts.fetch } : {}),
      ...(this.#opts.insecure ? { [oauth.allowInsecureRequests]: true } : {}),
      signal: AbortSignal.timeout(15_000),
    } as T;
  }

  /** The provider's metadata, discovered once; a failure is retried on the next sign-in. */
  #server(): Promise<oauth.AuthorizationServer> {
    this.#as ??= (async () => {
      const issuer = new URL(this.#s.issuer);
      const res = await oauth.discoveryRequest(issuer, {
        ...this.#http<oauth.DiscoveryRequestOptions>(),
        algorithm: "oidc",
      });
      return await oauth.processDiscoveryResponse(issuer, res);
    })().catch((e) => {
      this.#as = null;
      throw new OidcError("provider", `cannot reach the identity provider (${(e as Error).message})`);
    });
    return this.#as;
  }

  /** Begins a sign-in: the key for the cookie, and the provider's authorization URL to send the browser to. */
  async start(): Promise<{ key: string; url: URL }> {
    const as = await this.#server();
    if (!as.authorization_endpoint) {
      throw new OidcError("provider", "the identity provider has no authorization endpoint");
    }
    const now = this.#opts.now();
    for (const [k, p] of this.#pending) if (p.expires < now) this.#pending.delete(k);
    const key = oauth.generateRandomState();
    const pending = {
      state: oauth.generateRandomState(),
      nonce: oauth.generateRandomNonce(),
      verifier: oauth.generateRandomCodeVerifier(),
      expires: now + PENDING_MS,
    };
    this.#pending.set(key, pending);
    const url = new URL(as.authorization_endpoint);
    url.searchParams.set("client_id", this.#s.clientId);
    url.searchParams.set("redirect_uri", this.#s.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.#s.scopes);
    url.searchParams.set("state", pending.state);
    url.searchParams.set("nonce", pending.nonce);
    url.searchParams.set("code_challenge", await oauth.calculatePKCECodeChallenge(pending.verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { key, url };
  }

  /** Completes a sign-in from the callback URL; throws OidcError when it must be refused. */
  async finish(key: string | undefined, callback: URL): Promise<OidcIdentity> {
    const pending = key ? this.#pending.get(key) : undefined;
    if (key) this.#pending.delete(key);
    if (!pending || pending.expires < this.#opts.now()) {
      throw new OidcError("expired", "the sign-in took too long or was started elsewhere; try again");
    }
    const as = await this.#server();
    const client: oauth.Client = { client_id: this.#s.clientId };
    const auth = oauth.ClientSecretBasic(this.#s.clientSecret);
    let claims: oauth.IDToken;
    let accessToken: string;
    try {
      const params = oauth.validateAuthResponse(as, client, callback, pending.state);
      const res = await oauth.authorizationCodeGrantRequest(
        as,
        client,
        auth,
        params,
        this.#s.redirectUri,
        pending.verifier,
        this.#http<oauth.TokenEndpointRequestOptions>(),
      );
      const result = await oauth.processAuthorizationCodeResponse(as, client, res, {
        expectedNonce: pending.nonce,
        requireIdToken: true,
      });
      claims = oauth.getValidatedIdTokenClaims(result)!;
      accessToken = result.access_token;
    } catch (e) {
      // The provider's own words (e.g. "access_denied"), never a token.
      const detail = e instanceof oauth.AuthorizationResponseError
        ? e.error_description ?? e.error
        : (e as Error).message;
      throw new OidcError("provider", `the identity provider refused the sign-in (${detail})`);
    }
    let groups: unknown = claims[this.#s.groupsClaim];
    if (groups === undefined && as.userinfo_endpoint) {
      // Some providers put groups only in the user info, not the ID token.
      try {
        const res = await oauth.userInfoRequest(as, client, accessToken, this.#http<oauth.UserInfoRequestOptions>());
        const info = await oauth.processUserInfoResponse(as, client, claims.sub, res);
        groups = info[this.#s.groupsClaim];
      } catch {
        groups = undefined;
      }
    }
    const name = [claims.preferred_username, claims.name, claims.email, claims.sub].find(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    )!;
    if (!inGroup(groups, this.#s.group)) {
      throw new OidcError("group", `${name} is not in the group "${this.#s.group}"`);
    }
    return { externalId: `oidc:${claims.iss}#${claims.sub}`, name };
  }
}

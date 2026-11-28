import { useState } from "preact/hooks";
import type { AuthState } from "../../../shared/types.ts";
import { api, ApiRequestError } from "../api.ts";

/** Why a single sign-on came back refused (D69), by the code the server put in ?signin_error. */
export const SIGNIN_ERRORS: Record<string, string> = {
  group:
    "Your account is not allowed to use Tagmonia: it is not in the required group. Ask whoever runs the identity provider.",
  expired: "The sign-in took too long, or was started in another tab. Try again.",
  provider: "The identity provider did not sign you in. Try again, or sign in with your password.",
};

/** Reads and clears ?signin_error, so a reload does not show it again. */
function signinError(): string | null {
  const url = new URL(location.href);
  const code = url.searchParams.get("signin_error");
  if (!code) return null;
  url.searchParams.delete("signin_error");
  history.replaceState(null, "", url.pathname + url.search);
  return SIGNIN_ERRORS[code] ?? SIGNIN_ERRORS.provider;
}

/**
 * First-run setup (no user yet) or sign-in; both end in a signed-in session. With single sign-on configured
 * (D69), sign-in offers it first and the password form below it, as the fallback. Setup always creates the
 * local admin first, so there is a way in when the identity provider is down.
 */
export function AuthPage(
  { mode, sso, proxyRefused, onDone }: {
    mode: "setup" | "login";
    sso?: { name: string } | null;
    /** The trusted proxy signed in someone outside the group (D70). */
    proxyRefused?: string;
    onDone: (s: AuthState) => void;
  },
) {
  const [username, setUsername] = useState(mode === "setup" ? "admin" : "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(() =>
    signinError() ??
      (proxyRefused
        ? `You are signed in to the proxy as ${proxyRefused}, but that account is not in the group allowed to use Tagmonia. Sign in with a Tagmonia password, or ask whoever runs the proxy.`
        : null)
  );
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (mode === "setup" && password !== confirm) return setError("The passwords do not match.");
    setBusy(true);
    setError(null);
    try {
      onDone(await (mode === "setup" ? api.setup : api.login)({ username, password }));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Cannot reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="tm-narrow">
      <form class="tm-card tm-form" onSubmit={submit}>
        <h1>{mode === "setup" ? "Create the admin account" : "Sign in"}</h1>
        {mode === "login" && sso && (
          <>
            {/* A full navigation: the identity provider's page, then back to Tagmonia. */}
            <a class="tm-button tm-sso" href="/api/auth/oidc/start">Sign in with {sso.name}</a>
            <p class="tm-muted tm-or">or with your Tagmonia password</p>
          </>
        )}
        {mode === "setup" && (
          <p class="tm-muted">
            Tagmonia can change every file in your library, so it always requires a password. This account is created
            once, on first start.
          </p>
        )}
        <label>
          Username
          <input
            name="username"
            autocomplete="username"
            required
            value={username}
            onInput={(e) => setUsername(e.currentTarget.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            name="password"
            autocomplete={mode === "setup" ? "new-password" : "current-password"}
            required
            minLength={mode === "setup" ? 10 : undefined}
            value={password}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </label>
        {mode === "setup" && (
          <label>
            Confirm password
            <input
              type="password"
              autocomplete="new-password"
              required
              value={confirm}
              onInput={(e) => setConfirm(e.currentTarget.value)}
            />
          </label>
        )}
        {error && <p class="tm-error" role="alert">{error}</p>}
        <button class="tm-button" type="submit" disabled={busy}>
          {mode === "setup" ? "Create account" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

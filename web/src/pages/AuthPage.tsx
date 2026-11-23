import { useState } from "preact/hooks";
import type { AuthState } from "../../../shared/types.ts";
import { api, ApiRequestError } from "../api.ts";

/** First-run setup (no user yet) or sign-in; both end in a signed-in session. */
export function AuthPage({ mode, onDone }: { mode: "setup" | "login"; onDone: (s: AuthState) => void }) {
  const [username, setUsername] = useState(mode === "setup" ? "admin" : "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
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

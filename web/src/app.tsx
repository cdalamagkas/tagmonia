import { useEffect, useState } from "preact/hooks";
import type { HealthResponse } from "../../shared/types.ts";
import { api } from "./api.ts";

/** Phase 0 shell. Library, Review, Providers, Submit and Settings pages arrive in later phases. */
export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.health().then(setHealth, (e: Error) => setError(e.message));
  }, []);

  return (
    <>
      <header class="tm-header">
        <img src="/tagmony-logo-horizontal-white.svg" alt="Tagmony" />
      </header>
      <main>
        <section class="tm-card">
          <h1>Server status</h1>
          {error && <p class="tm-muted">Cannot reach the API: {error}</p>}
          {!health && !error && <p class="tm-muted">Checking…</p>}
          {health && (
            <>
              <p class="tm-muted">Version {health.version}</p>
              <div class="tm-check">{health.checks.musicRoot ? "✓" : "✗"} Music library mounted</div>
              <div class="tm-check">{health.checks.configDir ? "✓" : "✗"} Config directory writable</div>
            </>
          )}
        </section>
      </main>
    </>
  );
}

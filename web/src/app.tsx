import { useEffect, useState } from "preact/hooks";
import type { AuthState } from "../../shared/types.ts";
import { api, setUnauthorizedHandler } from "./api.ts";
import { AuthPage } from "./pages/AuthPage.tsx";
import { LibraryPage } from "./pages/LibraryPage.tsx";
import { ReleasePage } from "./pages/ReleasePage.tsx";
import { navigate, onLinkClick, useRoute } from "./router.ts";

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const route = useRoute();

  const refresh = () => api.session().then((s) => (setAuth(s), setError(null)), (e: Error) => setError(e.message));

  useEffect(() => {
    setUnauthorizedHandler(refresh);
    refresh();
  }, []);

  const logout = async () => {
    await api.logout().catch(() => {});
    navigate("/");
    refresh();
  };

  let body;
  if (error && !auth) {
    body = (
      <main class="tm-narrow">
        <p class="tm-error">Cannot reach the server: {error}</p>
      </main>
    );
  } else if (!auth) {
    body = (
      <main class="tm-narrow">
        <p class="tm-muted">Loading…</p>
      </main>
    );
  } else if (auth.setupRequired) body = <AuthPage mode="setup" onDone={setAuth} />;
  else if (!auth.user) body = <AuthPage mode="login" onDone={setAuth} />;
  else if (route.page === "library") body = <LibraryPage />;
  else if (route.page === "release") body = <ReleasePage id={route.id} />;
  else {body = (
      <main>
        <p>
          Page not found. <a href="/" onClick={onLinkClick}>Back to the library</a>
        </p>
      </main>
    );}

  return (
    <>
      <header class="tm-header">
        <a href="/" onClick={onLinkClick} class="tm-home">
          <img src="/tagmonia-logo-horizontal-white.svg" alt="Tagmonia" />
        </a>
        {auth?.user && (
          <nav class="tm-nav">
            <span>{auth.user.username}</span>
            <button type="button" class="tm-button tm-on-navy" onClick={logout}>Sign out</button>
          </nav>
        )}
      </header>
      {body}
    </>
  );
}

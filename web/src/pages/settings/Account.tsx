/**
 * Settings → Account (D71): who you are signed in as and how; with a local password, a form to change it. Accounts
 * from an identity provider or a proxy change their password there.
 */
import { useEffect, useState } from "preact/hooks";
import type { AuthState } from "../../../../shared/types.ts";
import { api } from "../../api.ts";
import { Note, type NoteValue } from "./Note.tsx";

export function AccountSection() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [note, setNote] = useState<NoteValue>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.session().then(setAuth, () => setAuth(null));
  }, []);
  const user = auth?.user;
  if (!user) return null;
  const submit = async (e: Event) => {
    e.preventDefault();
    if (next !== again) return setNote({ text: "The new passwords differ.", error: true });
    setBusy(true);
    setNote(null);
    try {
      await api.changePassword({ current, next });
      setCurrent("");
      setNext("");
      setAgain("");
      setNote({ text: "Password changed. Your other sessions are signed out." });
    } catch (err) {
      setNote({ text: (err as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="tm-card">
      <p class="tm-section-note">
        Signed in as <strong>{user.username}</strong>
        {user.signedInBy === "password"
          ? " with a Tagmonia password."
          : user.signedInBy === "sso"
          ? " through your identity provider, which manages its password."
          : " by your reverse proxy, which manages its password."}
      </p>
      {user.signedInBy === "password" && (
        <form class="tm-form tm-password-form" onSubmit={submit}>
          <input type="text" name="username" autocomplete="username" value={user.username} hidden readOnly />
          <label>
            Current password
            <input
              type="password"
              autocomplete="current-password"
              required
              value={current}
              onInput={(e) => setCurrent(e.currentTarget.value)}
            />
          </label>
          <label>
            New password
            <input
              type="password"
              autocomplete="new-password"
              required
              minLength={10}
              value={next}
              onInput={(e) => setNext(e.currentTarget.value)}
            />
          </label>
          <label>
            New password again
            <input
              type="password"
              autocomplete="new-password"
              required
              value={again}
              onInput={(e) => setAgain(e.currentTarget.value)}
            />
          </label>
          <button type="submit" class="tm-button" disabled={busy}>Change password</button>
        </form>
      )}
      <Note note={note} />
    </section>
  );
}

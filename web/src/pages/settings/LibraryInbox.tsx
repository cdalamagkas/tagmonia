/** Settings → Library & inbox: the inbox, where new music waits, and how often it is looked at (D57, D60). */
import { useEffect, useState } from "preact/hooks";
import { api } from "../../api.ts";
import { onLinkClick } from "../../router.ts";
import { Note, type NoteValue } from "./Note.tsx";

export function LibraryInboxSection() {
  /** Undefined while loading, null when no inbox is configured. */
  const [inbox, setInbox] = useState<object | null | undefined>(undefined);
  /** How often the inbox is also looked at (D60), as saved; null while loading. */
  const [poll, setPoll] = useState<number | null>(null);
  const [note, setNote] = useState<NoteValue>(null);
  useEffect(() => {
    api.settings().then((s) => setPoll(s.scanner.inboxPollMinutes)).catch((e) =>
      setNote({ text: e.message, error: true })
    );
    api.summary().then((s) => setInbox(s.inbox), (e) => setNote({ text: e.message, error: true }));
  }, []);

  const savePoll = async (value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 1440) {
      return setNote({ text: "Give a whole number of minutes, 0 to 1440", error: true });
    }
    try {
      const r = await api.updateSettings({ scanner: { inboxPollMinutes: n } });
      setPoll(r.settings.scanner.inboxPollMinutes);
      setNote({
        text: n === 0 ? "The inbox is no longer checked on a timer." : `The inbox is checked every ${n} minutes.`,
      });
    } catch (err) {
      setNote({ text: (err as Error).message, error: true });
    }
  };

  return (
    <section class="tm-card">
      <h2>Inbox</h2>
      {inbox === null && (
        <p class="tm-muted tm-section-note">
          No inbox is set up. Set <code>TAGMONIA_INBOX_DIR</code>{" "}
          to a folder for new music; albums there move into the library when you write them.
        </p>
      )}
      {inbox && (
        <>
          <p class="tm-section-note">
            Albums in the inbox move into the library when you write them, named by the template in{" "}
            <a href="/settings/files" onClick={onLinkClick}>Files &amp; naming</a>.
          </p>
          <p class="tm-muted tm-small-note">
            New albums are picked up once they finish copying. Some network shares do not report changes, so the inbox
            is also checked on a timer.
          </p>
          <label class="tm-inline-field">
            Check every
            <input
              type="number"
              class="tm-number-small"
              min={0}
              max={1440}
              step={1}
              value={poll ?? ""}
              onChange={(e) => savePoll(e.currentTarget.value)}
            />
            minutes <span class="tm-small-note">(0 turns the timer off)</span>
          </label>
        </>
      )}
      <Note note={note} />
    </section>
  );
}

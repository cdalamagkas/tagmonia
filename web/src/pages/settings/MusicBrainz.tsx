/** Settings → MusicBrainz: where releases missing from MusicBrainz are added (D52). */
import { useEffect, useState } from "preact/hooks";
import type { SettingsDto } from "../../../../shared/types.ts";
import { api } from "../../api.ts";
import { Note, type NoteValue } from "./Note.tsx";

type SubmitServer = SettingsDto["submission"]["server"];

/** Settings → MusicBrainz submissions (D52): where releases missing from MusicBrainz are added. */
function SubmissionSettings() {
  const [server, setServer] = useState<SubmitServer | null>(null);
  const [note, setNote] = useState<NoteValue>(null);
  useEffect(() => {
    api.settings().then((s) => setServer(s.submission.server)).catch((e) => setNote({ text: e.message, error: true }));
  }, []);
  const choose = async (v: SubmitServer) => {
    const previous = server;
    setServer(v);
    try {
      await api.updateSettings({ submission: { server: v } });
      setNote({ text: "Saved. It applies to submissions prepared from now on." });
    } catch (e) {
      setServer(previous);
      setNote({ text: (e as Error).message, error: true });
    }
  };
  const options: { value: SubmitServer; label: string; note: string }[] = [
    {
      value: "https://musicbrainz.org",
      label: "musicbrainz.org",
      note: "The real database. What you submit there is public and is how Jellyfin and others will know the release.",
    },
    {
      value: "https://test.musicbrainz.org",
      label: "test.musicbrainz.org",
      note:
        "For trying submissions out, with a separate test account. Releases added there exist only there, and its identifiers mean nothing on musicbrainz.org.",
    },
  ];
  return (
    <section class="tm-card">
      <h2>Submissions</h2>
      <p class="tm-muted tm-section-note">
        For releases MusicBrainz does not have yet: Tagmonia opens the release editor filled in, and you submit it from
        your own account.
      </p>
      {server && (
        <div class="tm-radio-list" role="radiogroup" aria-label="Where releases are added">
          {options.map((o) => (
            <label key={o.value} class="tm-check">
              <input type="radio" name="submit-server" checked={server === o.value} onChange={() => choose(o.value)} />
              <span>
                <strong>{o.label}</strong>
                {o.value === "https://musicbrainz.org" && <span class="tm-muted">(default)</span>}
                <br />
                <span class="tm-muted">{o.note}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <Note note={note} />
    </section>
  );
}

export function MusicBrainzSection() {
  return <SubmissionSettings />;
}

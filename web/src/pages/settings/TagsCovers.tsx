/** Settings → Tags & covers: how a release's cover is written (D49). */
import { useEffect, useState } from "preact/hooks";
import type { SettingsDto } from "../../../../shared/types.ts";
import { api } from "../../api.ts";
import { Note, type NoteValue } from "./Note.tsx";

type CoverMode = SettingsDto["covers"]["mode"];

const COVER_MODES: { mode: CoverMode; label: string; note: string }[] = [
  {
    mode: "embed_full",
    label: "Embed full size",
    note: "The largest image available, in every file. Best quality; each file carries the whole image.",
  },
  {
    mode: "embed_1200",
    label: "Embed about 1200 px",
    note: "Sharp on any screen without making each file much bigger.",
  },
  {
    mode: "folder",
    label: "Folder image only",
    note: "Save cover.jpg next to the tracks and leave the files' pictures alone. Jellyfin and Navidrome read it.",
  },
  {
    mode: "both",
    label: "Both",
    note: "Embed about 1200 px and also save the full-size image as cover.jpg in the folder.",
  },
];

/** Settings → Cover art (D49): how a release's cover is written. Applies to proposals built after the change. */
function CoverSettings() {
  const [mode, setMode] = useState<CoverMode | null>(null);
  const [note, setNote] = useState<NoteValue>(null);
  useEffect(() => {
    api.settings().then((s) => setMode(s.covers.mode)).catch((e) => setNote({ text: e.message, error: true }));
  }, []);
  const choose = async (m: CoverMode) => {
    const previous = mode;
    setMode(m);
    try {
      await api.updateSettings({ covers: { mode: m } });
      setNote({ text: "Saved. Proposals built from now on use it; build a release again to apply it there." });
    } catch (e) {
      setMode(previous);
      setNote({ text: (e as Error).message, error: true });
    }
  };
  return (
    <section class="tm-card">
      <h2>Cover art</h2>
      <p class="tm-muted tm-section-note">
        The front cover comes from the Cover Art Archive, or else the largest image Deezer, iTunes or Discogs has for
        the same release. It is shown in the review before anything is written.
      </p>
      {mode && (
        <div class="tm-radio-list" role="radiogroup" aria-label="How covers are written">
          {COVER_MODES.map((m) => (
            <label key={m.mode} class="tm-check">
              <input type="radio" name="cover-mode" checked={mode === m.mode} onChange={() => choose(m.mode)} />
              <span>
                <strong>{m.label}</strong>
                {m.mode === "embed_full" && <span class="tm-muted">(default)</span>}
                <br />
                <span class="tm-muted">{m.note}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <Note note={note} />
    </section>
  );
}

export function TagsCoversSection() {
  return <CoverSettings />;
}

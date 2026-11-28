/** A section's answer after saving: what happened, or the server's error. */
export type NoteValue = { text: string; error?: boolean } | null;

export function Note({ note }: { note: NoteValue }) {
  if (!note) return null;
  return <p class={note.error ? "tm-error" : "tm-muted"} role={note.error ? "alert" : undefined}>{note.text}</p>;
}

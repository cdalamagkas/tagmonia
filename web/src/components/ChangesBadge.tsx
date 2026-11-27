/** The prepared changes of a release in a few words (D61): in the library list, and on the release's Tags tab. */
import type { ReleaseChangesDto } from "../../../shared/types.ts";
import { changesLabel } from "../release/status.ts";

export function ChangesBadge({ changes }: { changes: ReleaseChangesDto | null }) {
  const c = changesLabel(changes);
  if (!c.tone) return <span class="tm-muted" title={c.title}>{c.label}</span>;
  return <span class={`tm-badge tm-inline tm-badge-${c.tone}`} title={c.title}>{c.label}</span>;
}

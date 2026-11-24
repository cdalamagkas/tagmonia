/** Flattens a MusicBrainz release into what scoring and the edition picker need. */
import type { MbArtistCredit, MbRelease } from "../providers/musicbrainz/schema.ts";
import type { ReleaseSummary, ReleaseView } from "./types.ts";

export function creditString(credit: MbArtistCredit | undefined): string {
  return (credit ?? []).map((c) => c.name + c.joinphrase).join("");
}

/** "2×CD", "CD + DVD", or "" when MusicBrainz has no format. */
export function formatString(formats: (string | null | undefined)[]): string {
  const runs: [string, number][] = [];
  for (const f of formats) {
    const name = f ?? "(unknown format)";
    const last = runs.at(-1);
    if (last && last[0] === name) last[1]++;
    else runs.push([name, 1]);
  }
  return runs.map(([name, n]) => (n > 1 ? `${n}×${name}` : name)).join(" + ");
}

/** The release fields a search hit and a full lookup share. */
type ReleaseHead = Pick<
  MbRelease,
  "title" | "date" | "country" | "barcode" | "status" | "artist-credit" | "label-info"
>;

export function releaseSummary(r: ReleaseHead & { media: { format?: string | null }[] }, trackCount: number) {
  const labels = (r["label-info"] ?? []).map((l) => l.label?.name).filter((x): x is string => !!x);
  const catnos = (r["label-info"] ?? []).map((l) => l["catalog-number"]).filter((x): x is string => !!x);
  const summary: ReleaseSummary = {
    title: r.title,
    artist: creditString(r["artist-credit"]),
    date: r.date || null,
    country: r.country ?? null,
    labels: [...new Set(labels)],
    catalogNumbers: [...new Set(catnos)],
    barcode: r.barcode || null,
    format: formatString(r.media.map((m) => m.format)),
    trackCount,
    status: r.status ?? null,
  };
  return summary;
}

export function toReleaseView(r: MbRelease): ReleaseView {
  const tracks = r.media.flatMap((m) =>
    (m.tracks ?? []).map((t) => ({
      medium: m.position,
      position: t.position,
      title: t.title,
      lengthMs: t.length ?? t.recording.length ?? null,
      trackId: t.id,
      recordingId: t.recording.id,
    }))
  );
  return {
    id: r.id,
    releaseGroupId: r["release-group"]?.id ?? null,
    summary: releaseSummary(r, tracks.length),
    tracks,
  };
}

/** UPC-A and EAN-13 differ by a leading zero; compare digits without leading zeros. */
export function normalizeBarcode(s: string | null | undefined): string | null {
  const d = (s ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return d.length >= 6 ? d : null;
}

/** Catalog numbers vary in case, spaces and separators ("CAT-001" vs "cat 001"). */
export function normalizeCatno(s: string | null | undefined): string | null {
  const t = (s ?? "").toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
  return t && t !== "NONE" ? t : null;
}

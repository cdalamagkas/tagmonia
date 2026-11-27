/**
 * The release-editor seed for a release missing from MusicBrainz (§12.2, D52).
 * Harmony builds the form fields from the providers' merged release; Tagmonia
 * writes the edit note: every provider page used, the Tagmonia version, and when
 * the data was fetched, so MusicBrainz editors can check the sources.
 */
import type { ProviderMatch, SourceProvider } from "../providers/enrichment.ts";
import { buildReleaseSeed, type MergedRelease, mergeProviderReleases } from "../providers/harmony_adapter.ts";
import { PROJECT_URL, VERSION } from "../version.ts";

/** The providers' release, merged as the proposal was: the linked provider first (D51). */
export function mergedFromMatches(matches: ProviderMatch[], primary: SourceProvider | "youtube"): MergedRelease {
  const found = matches.filter((m) => m.status === "found" && m.release);
  const first = found.find((m) => m.provider === primary);
  if (!first) throw new Error(`the ${primary} release is no longer stored with the proposal; build it again`);
  const name = (m: ProviderMatch) => m.release!.info.providers[0]?.name ?? m.provider;
  const map: Record<string, NonNullable<ProviderMatch["release"]>> = { [name(first)]: first.release! };
  for (const m of found) if (m !== first) map[name(m)] = m.release!;
  return mergeProviderReleases(map, name(first));
}

export function editNote(release: MergedRelease, fetchedAt: number): string {
  const lines = release.info.providers.map((p) => `* ${p.name}: ${p.url}${p.apiUrl ? ` (API: ${p.apiUrl})` : ""}`);
  const when = new Date(fetchedAt).toISOString().replace(/:\d\d\.\d+Z$/, " UTC").replace("T", " ");
  return [
    `Imported with Tagmonia ${VERSION} (${PROJECT_URL}), using data from:`,
    ...lines,
    `Data fetched ${when}; merged with Harmony and reviewed by the editor before submission.`,
  ].join("\n");
}

/**
 * Form fields for `<server>/release/add`. `returnUrl` is where MusicBrainz sends the
 * browser after submission: Harmony replaces its query with lookup details, so the
 * submission id travels in the path.
 */
export function seedFor(release: MergedRelease, opts: { returnUrl: URL; fetchedAt: number }): Record<string, string> {
  const seed = buildReleaseSeed(release, { projectUrl: new URL(PROJECT_URL), redirectUrl: opts.returnUrl });
  seed.edit_note = editNote(release, opts.fetchedAt);
  return seed;
}

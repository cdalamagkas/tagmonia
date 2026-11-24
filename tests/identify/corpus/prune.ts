/**
 * Corpus recordings drop the relationship blocks identification never reads
 * (credits, work links, "based on" lists), which are most of a release lookup's
 * size (D38). Everything scoring uses stays byte-for-byte as MusicBrainz sent it.
 * The client tests keep their own unpruned recordings for relationship coverage.
 */
export function pruneRelease(body: string): string {
  const json = JSON.parse(body);
  if (!json || typeof json !== "object" || !Array.isArray(json.media)) return body;
  delete json.relations;
  for (const m of json.media) {
    for (const t of m.tracks ?? []) {
      if (t.recording) delete t.recording.relations;
    }
  }
  return JSON.stringify(json);
}

/** Release lookups only: /ws/2/release/<mbid>?inc=… */
export function isReleaseLookup(url: URL): boolean {
  return /\/ws\/2\/release\/[0-9a-f-]{36}$/.test(url.pathname);
}

/** A provider release missing from MusicBrainz, as Harmony gives it, for submission tests (D52). */
import type { ProviderMatch } from "../../server/providers/enrichment.ts";
import type { HarmonizedRelease } from "../../server/providers/harmony_adapter.ts";

export function ep(name: string, internalName: string, extra: { isrc?: boolean } = {}): HarmonizedRelease {
  return {
    title: "Ambient Piano Vol.1",
    artists: [{ name: "Niklas Blumenthaler", creditedName: "Niklas Blumenthaler" }],
    gtin: "196292081398",
    externalLinks: [{ url: `https://www.${internalName}.com/album/1`, types: ["free streaming"] }],
    status: "Official",
    types: ["EP"],
    releaseDate: { date: { year: 2021, month: 7, day: 23 }, quality: "assumed-valid" },
    labels: [{ name: "LKult" }],
    media: [{
      number: 1,
      format: "Digital Media",
      tracklist: ["Yellow Happiness", "Peaceful Blue"].map((title, i) => ({
        title,
        number: i + 1,
        length: 140_000 + i * 2000,
        ...(extra.isrc ? { isrc: `QMFME213007${i}` } : {}),
      })),
    }],
    info: {
      providers: [{
        name,
        internalName,
        id: "1",
        url: `https://www.${internalName}.com/album/1`,
        apiUrl: `https://api.${internalName}.com/album/1`,
        lookup: { method: internalName === "deezer" ? "id" : "gtin", value: "1" },
      }],
      messages: [],
    },
  } as unknown as HarmonizedRelease;
}

export const MATCHES: ProviderMatch[] = [
  {
    provider: "deezer",
    status: "found",
    via: "link",
    url: null,
    reason: null,
    release: ep("Deezer", "deezer", { isrc: true }),
  },
  { provider: "itunes", status: "found", via: "barcode", url: null, reason: null, release: ep("iTunes", "itunes") },
  { provider: "discogs", status: "not_found", via: "barcode", url: null, reason: "no", release: null },
];

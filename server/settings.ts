/**
 * UI-managed settings in /config/settings.json (ARCHITECTURE.md §15.2),
 * validated against a schema at startup. Missing keys take defaults; an
 * invalid file stops startup rather than silently resetting the user's choices.
 */
import { join } from "node:path";
import { z } from "zod";
import type { IdentifyConfig } from "./identify/identify.ts";

function isPublicMusicBrainz(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "musicbrainz.org" || host.endsWith(".musicbrainz.org");
}

export const settingsSchema = z.object({
  scanner: z.object({
    /** Globs relative to the music root, e.g. "Podcasts/**" or "**\/_Incoming". */
    ignore: z.array(z.string().min(1)).default([]),
  }).prefault({}),
  providers: z.object({
    musicbrainz: z.object({
      /** A local mirror for large libraries (§9.3); must end at the /ws/2/ root. */
      baseUrl: z.url({ protocol: /^https?$/ }).default("https://musicbrainz.org/ws/2/"),
      /** Only a mirror may go faster than the public server's 1 request per second (D32). */
      requestsPerSecond: z.number().positive().max(50).default(1),
    }).prefault({}).refine(
      (mb) => mb.requestsPerSecond <= 1 || !isPublicMusicBrainz(mb.baseUrl),
      { message: "musicbrainz.org allows at most 1 request per second", path: ["requestsPerSecond"] },
    ),
    acoustid: z.object({
      /** AcoustID allows at most 3 requests per second (D37). */
      requestsPerSecond: z.number().positive().max(3).default(3),
      /** AcoustID matches scoring below this are ignored. */
      minScore: z.number().min(0).max(1).default(0.5),
    }).prefault({}),
  }).prefault({}),
  identify: z.object({
    /** §8.1: at or above, a match may be auto-approved (only if the user enables it, Phase 3). */
    autoThreshold: z.number().min(0).max(1).default(0.92),
    /** Below this there is "no confident match". */
    reviewThreshold: z.number().min(0).max(1).default(0.70),
    /** §8.2: same-release-group releases this close to the best go to the edition picker. */
    editionMargin: z.number().min(0).max(0.5).default(0.03),
    /** D36: share of the total weight that must have evidence before a match may reach autoThreshold. */
    minCoverage: z.number().min(0).max(1).default(0.6),
    /** D36: full release lookups per search, at 1 request per second each. */
    maxLookupsPerSearch: z.number().int().min(1).max(25).default(5),
    /** §8.1 initial weights; tuned on tests/identify/. Missing signals are excluded, not scored 0 (D36). */
    weights: z.object({
      trackCount: z.number().min(0).default(0.20),
      durations: z.number().min(0).default(0.25),
      titles: z.number().min(0).default(0.20),
      album: z.number().min(0).default(0.10),
      artist: z.number().min(0).default(0.10),
      fingerprint: z.number().min(0).default(0.15),
    }).prefault({}),
  }).prefault({}).refine((i) => i.reviewThreshold < i.autoThreshold, {
    message: "reviewThreshold must be below autoThreshold",
    path: ["reviewThreshold"],
  }),
  auth: z.object({
    /** Sessions end after this long without a request. */
    sessionIdleHours: z.number().positive().max(24 * 90).default(24 * 7),
    /** Sessions end this long after login regardless of activity. */
    sessionMaxDays: z.number().positive().max(365).default(30),
  }).prefault({}),
}).strict();

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

export async function loadSettings(configDir: string): Promise<Settings> {
  const path = join(configDir, "settings.json");
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    await Deno.writeTextFile(path, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
    return DEFAULT_SETTINGS;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const parsed = settingsSchema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new Error(`${path} is invalid at: ${where}`);
  }
  return parsed.data;
}

/** Identification settings in the shape the pure identify code takes. */
export function identifyConfig(s: Settings): IdentifyConfig {
  const i = s.identify;
  return {
    scoring: { weights: i.weights, autoThreshold: i.autoThreshold, minCoverage: i.minCoverage, identifierFloor: 0.95 },
    thresholds: { autoThreshold: i.autoThreshold, reviewThreshold: i.reviewThreshold, editionMargin: i.editionMargin },
    maxLookupsPerSearch: i.maxLookupsPerSearch,
  };
}

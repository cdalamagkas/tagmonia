/**
 * UI-managed settings in /config/settings.json (ARCHITECTURE.md §15.2),
 * validated against a schema at startup. Missing keys take defaults; an
 * invalid file stops startup rather than silently resetting the user's choices.
 */
import { activeTemplate, DEFAULT_TEMPLATE_ID, validateNamingSettings } from "../shared/naming.ts";
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
    /**
     * The inbox (D60) is also looked at this often, for file systems that send no change events (SMB/NFS
     * mounts, WSL's /mnt/c); 0 = change events only.
     */
    inboxPollMinutes: z.number().int().min(0).max(1440).default(5),
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
    // Enrichment providers (§9.2): on by default; Discogs acts only once it has credentials.
    deezer: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    itunes: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    discogs: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    // Opt-in (D16): reads public pages, no official API. Only used from a Bandcamp link the user gives (D51).
    bandcamp: z.object({ enabled: z.boolean().default(false) }).prefault({}),
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
  proposal: z.object({
    /** §10.3, D27: where `genre` comes from. */
    genres: z.enum(["musicbrainz", "none"]).default("musicbrainz"),
    maxGenres: z.number().int().min(1).max(20).default(5),
  }).prefault({}),
  submission: z.object({
    /**
     * Where releases missing from MusicBrainz are seeded (§12, D52). The test server is for trying
     * Tagmonia out: what is added there exists only there, and its MBIDs mean nothing elsewhere.
     */
    server: z.enum(["https://musicbrainz.org", "https://test.musicbrainz.org"]).default("https://musicbrainz.org"),
  }).prefault({}),
  covers: z.object({
    /**
     * D46, D49: embed about 1200 px, embed full size, only save cover.jpg in the album folder,
     * or embed about 1200 px and save the full-size cover.jpg.
     */
    mode: z.enum(["embed_1200", "embed_full", "folder", "both"]).default("embed_full"),
  }).prefault({}),
  files: z.object({
    /**
     * How written albums are named, relative to the library (D57; shared/naming.ts): the template in use, a
     * built-in one or one of the user's saved templates. Inbox albums are moved by it on Write; renaming
     * albums already in the library is opt-in.
     */
    active: z.string().max(60).default(DEFAULT_TEMPLATE_ID),
    /** Rename (and move) albums already in the library when writing them; off by default (D57). */
    renameLibrary: z.boolean().default(false),
    templates: z.array(
      z.object({
        id: z.string().max(60),
        name: z.string().max(80),
        template: z.string().max(500),
      }).strict(),
    ).default([]),
  }).prefault({}).superRefine((files, ctx) => {
    for (const issue of validateNamingSettings(files)) ctx.addIssue({ code: "custom", ...issue });
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
    // A copy: settings are updated in place (updateSettings), and the defaults must stay the defaults.
    return structuredClone(DEFAULT_SETTINGS);
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

/** Settings read once at startup (rate limiters, sessions): changing them needs a restart. */
const STARTUP_ONLY = ["providers.musicbrainz", "providers.acoustid.requestsPerSecond", "auth"];

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Objects merge key by key; arrays and scalars replace. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
  return out;
}

function changedPaths(a: unknown, b: unknown, prefix = ""): string[] {
  if (isObject(a) && isObject(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) =>
      changedPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k)
    );
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
}

export class SettingsError extends Error {
  override name = "SettingsError";
}

/**
 * Applies a partial change from the UI (§15.2): validated like the file at
 * startup, written atomically, then copied into `settings` in place so every
 * job and route that holds it sees the change. Returns the changed paths that
 * only take effect after a restart.
 */
export async function updateSettings(configDir: string, settings: Settings, patch: unknown): Promise<string[]> {
  const parsed = settingsSchema.safeParse(deepMerge(structuredClone(settings), patch));
  if (!parsed.success) {
    // A rule's own message ("The template has unknown field …") says what to fix; the generic ones only where.
    const what = parsed.error.issues.map((i) =>
      i.code === "custom" ? `${i.path.join(".")}: ${i.message}` : i.path.join(".")
    );
    throw new SettingsError(`invalid settings: ${what.join(", ")}`);
  }
  const changed = changedPaths(settings, parsed.data);
  const path = join(configDir, "settings.json");
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(parsed.data, null, 2) + "\n");
  await Deno.rename(tmp, path);
  for (const k of Object.keys(parsed.data) as (keyof Settings)[]) {
    (settings as Record<string, unknown>)[k] = parsed.data[k];
  }
  return changed.filter((c) => STARTUP_ONLY.some((s) => c === s || c.startsWith(`${s}.`)));
}

/** Renaming on write (D57): the template in use and whether albums in the library are renamed. */
export function namingOf(s: Settings): { template: string; renameLibrary: boolean } {
  return { template: activeTemplate(s.files).template, renameLibrary: s.files.renameLibrary };
}

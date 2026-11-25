/**
 * The `propose` job (§10): builds the proposal for one release from a chosen
 * MusicBrainz release. Enqueued automatically when identification is confident
 * ("matched"), or when the user picks a release or edition. Reads stored tags
 * and calls MusicBrainz; never touches the library, so it runs in read-only mode.
 */
import { z } from "zod";
import type { Db } from "../db/db.ts";
import { getRelease } from "../db/repo/library.ts";
import { type ChosenBy, latestProposal, listLocks, saveProposal, saveProviderMatches } from "../db/repo/proposals.ts";
import {
  type EnrichmentDeps,
  findOnProviders,
  linksOf,
  LOOKUP_OPTIONS,
  lookupLink,
  type ProviderMatch,
  type SourceProvider,
  targetOfHarmony,
  targetOfMb,
} from "../providers/enrichment.ts";
import { type HarmonizedRelease, mergeProviderReleases } from "../providers/harmony_adapter.ts";
import { providerReleaseView, tagsFromProviders } from "../proposal/harmony_tags.ts";
import { toReleaseView } from "../identify/release.ts";
import { DEFAULT_SCORING, scoreRelease } from "../identify/score.ts";
import type { Logger } from "../log.ts";
import { buildFieldProposals } from "../proposal/build.ts";
import { mergeProviders } from "../proposal/merge.ts";
import { chooseCover, type CoverFetcher } from "../covers/fetch.ts";
import { folderCoverPath, readFolderCover } from "../covers/folder.ts";
import type { CoverMode } from "../covers/sources.ts";
import { embedStatus, folderFileName, folderStatus } from "../covers/status.ts";
import { saveCover } from "../db/repo/covers.ts";
import { missingParentWorks, tagsFromMusicBrainz } from "../proposal/musicbrainz_tags.ts";
import type { Cited } from "../providers/musicbrainz/client.ts";
import { mbidSchema, type MbRelease, type MbReleaseExtras, type MbWork } from "../providers/musicbrainz/schema.ts";
import { buildEvidence } from "./identify.ts";
import { getEvidenceLink } from "../db/repo/evidence.ts";
import { applyEvidence, youtubeMatch } from "../proposal/evidence.ts";
import { parseYouTubeUrl, type YouTubeEvidence, type YouTubeLink } from "../providers/youtube.ts";
import { type Job, type JobQueue, PermanentJobError } from "./queue.ts";

export const PROPOSE_JOB = "propose";

export interface ProposalSource {
  lookupRelease(mbid: string, signal?: AbortSignal): Promise<Cited<MbRelease> | null>;
  lookupReleaseExtras(mbid: string, signal?: AbortSignal): Promise<Cited<MbReleaseExtras> | null>;
  lookupWork(mbid: string, signal?: AbortSignal): Promise<Cited<MbWork> | null>;
}

export interface ProposalSettings {
  /** D27: MusicBrainz genres by default; "none" leaves genre alone. */
  genres: "musicbrainz" | "none";
  maxGenres: number;
}

/** Cover art (D49): where images come from, the mode setting, and the music root for the folder file. */
export interface CoverDeps {
  fetcher: Pick<CoverFetcher, "listing" | "download">;
  mode: () => CoverMode;
  musicDir: string;
}

export interface ProposeJobDeps {
  db: Db;
  mb: ProposalSource;
  /** MusicBrainz on another server (D52); absent = only `mb`. */
  mbFor?: (server: string) => ProposalSource;
  covers?: CoverDeps | null;
  /** Deezer, iTunes and Discogs through Harmony (D47); absent = MusicBrainz only. */
  enrichment?: EnrichmentDeps | null;
  /** YouTube evidence (§9.5, D55): null while no API key is set. */
  youtube?: () => Promise<{ evidence(link: YouTubeLink, signal?: AbortSignal): Promise<YouTubeEvidence> } | null>;
  settings: () => ProposalSettings;
  logger: Logger;
  now?: () => number;
}

/** The release's YouTube link, looked up again for every proposal; null when it has none. */
export async function evidenceMatch(
  deps: ProposeJobDeps,
  candidateId: number,
  trackCount: number,
  signal?: AbortSignal,
): Promise<ProviderMatch | null> {
  const link = getEvidenceLink(deps.db, candidateId);
  if (!link) return null;
  const base = { provider: "youtube" as const, via: "link" as const, url: link.url, release: null };
  const parsed = parseYouTubeUrl(new URL(link.url));
  if ("error" in parsed) return { ...base, status: "error", reason: parsed.error };
  const client = await deps.youtube?.();
  if (!client) return { ...base, status: "skipped", reason: "no YouTube API key (Settings → Providers)" };
  try {
    return youtubeMatch(await client.evidence(parsed, signal), trackCount);
  } catch (e) {
    if (signal?.aborted) throw e;
    // A refused key or a deleted playlist must not stop the proposal: the row says why.
    return { ...base, status: "error", reason: (e as Error).message.slice(0, 300) };
  }
}

const payloadSchema = z.union([
  z.object({
    candidateId: z.number().int().positive(),
    releaseMbid: mbidSchema,
    chosenBy: z.enum(["auto", "user"]),
    /** Another MusicBrainz server than the configured one: the test server after a test submission (D52). */
    server: z.literal("https://test.musicbrainz.org").optional(),
  }),
  // A release not on MusicBrainz, from a provider link the user gave (§10.4, D51).
  z.object({
    candidateId: z.number().int().positive(),
    providerUrl: z.url({ protocol: /^https$/ }),
    chosenBy: z.literal("user"),
  }),
]);

export interface ProposeJobResult {
  proposalId: number;
  changed: number;
  added: number;
  unchanged: number;
  unmappedFiles: number;
}

/** Parent works are nested (act → opera); a few rounds reach the top of any real work. */
const MAX_WORK_ROUNDS = 3;

export function registerProposeJob(queue: JobQueue, deps: ProposeJobDeps): void {
  const now = deps.now ?? Date.now;
  queue.register(PROPOSE_JOB, async ({ job, signal }): Promise<ProposeJobResult | null> => {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) throw new PermanentJobError("invalid propose payload");
    const { candidateId, chosenBy } = parsed.data;
    const found = getRelease(deps.db, candidateId);
    if (!found) return null;
    const { content_hash: contentHash } = deps.db.prepare("SELECT content_hash FROM candidate WHERE id = ?").get(
      candidateId,
    ) as { content_hash: string };
    if ("providerUrl" in parsed.data) {
      return await proposeFromProvider(deps, new URL(parsed.data.providerUrl), found, contentHash, now, signal);
    }
    const { releaseMbid, server } = parsed.data;
    if (server && !deps.mbFor) throw new PermanentJobError(`${server} is not set up`);
    const mb = server ? deps.mbFor!(server) : deps.mb;

    const rel = await mb.lookupRelease(releaseMbid, signal);
    if (!rel) throw new PermanentJobError(`MusicBrainz has no release ${releaseMbid}`);
    const snapshotIds = [rel.snapshotId];

    const settings = deps.settings();
    // Genres and links to other providers in one request; links are needed even with genres off.
    const extras = await mb.lookupReleaseExtras(rel.value.id, signal);
    if (extras) snapshotIds.push(extras.snapshotId);
    const genres: MbReleaseExtras | null = settings.genres === "musicbrainz" ? extras?.value ?? null : null;

    const parents = new Map<string, MbWork>();
    for (let round = 0; round < MAX_WORK_ROUNDS; round++) {
      const missing = missingParentWorks(rel.value, parents);
      if (missing.length === 0) break;
      for (const id of missing) {
        const w = await mb.lookupWork(id, signal);
        if (w) {
          parents.set(id, w.value);
          snapshotIds.push(w.snapshotId);
        }
      }
    }

    // Map the files as they are now, not as identification saw them: a rescan may have changed them.
    const files = found.files.filter((f) => !f.readError);
    const { mapping } = scoreRelease(
      buildEvidence(found.release.mbid, files),
      toReleaseView(rel.value),
      DEFAULT_SCORING,
    );
    const proposed = tagsFromMusicBrainz({
      release: rel.value,
      genres,
      parentWorks: parents,
      maxGenres: settings.maxGenres,
    });
    // The same release on other providers (D47), merged into the fields by precedence (D48).
    const matches = deps.enrichment
      ? await findOnProviders(deps.enrichment, targetOfMb(rel.value), linksOf(extras?.value ?? null))
      : null;
    const merged = mergeProviders(proposed, rel.value, matches ?? []);
    const youtube = await evidenceMatch(deps, candidateId, targetOfMb(rel.value).trackCount, signal);
    applyEvidence(merged, youtube);
    const rows = youtube ? [...(matches ?? []), youtube] : matches;
    const build = buildFieldProposals({
      candidateId,
      files: files.map((f) => ({ id: f.id, tags: f.tags })),
      mapping: mapping.pairs,
      proposed: merged,
      snapshotId: rel.snapshotId,
      locks: listLocks(deps.db),
      provenance: merged.provenance,
    });
    const proposalId = saveProposal(deps.db, {
      candidateId,
      releaseMbid: rel.value.id,
      mbServer: server ?? null,
      chosenBy,
      basedOnHash: contentHash,
      snapshotIds: [...new Set(snapshotIds)],
      build: {
        ...build,
        unmappedFiles: [...build.unmappedFiles, ...found.files.filter((f) => f.readError).map((f) => f.id)],
      },
    }, now());
    if (rows) saveProviderMatches(deps.db, proposalId, rows, now());
    if (deps.covers) {
      const mappedIds = new Set(mapping.pairs.map((p) => p.fileId));
      await proposeCover(
        deps.db,
        deps.covers,
        proposalId,
        rel.value,
        matches ?? [],
        found.release.folder,
        files.filter((f) => mappedIds.has(f.id)),
        signal,
      );
    }
    const count = (s: string) => build.fields.filter((f) => f.status === s).length;
    return {
      proposalId,
      changed: count("changed"),
      added: count("added"),
      unchanged: count("unchanged"),
      unmappedFiles: build.unmappedFiles.length,
    };
  });
}

/** Chooses and downloads the release's cover, compares it with what the files and folder have, and stores it. */
async function proposeCover(
  db: Db,
  deps: CoverDeps,
  proposalId: number,
  release: { id: string; "cover-art-archive"?: { front?: boolean; darkened?: boolean } },
  matches: ProviderMatch[],
  folder: string,
  files: { pictures: { type: string; mime: string; size: number }[] }[],
  signal?: AbortSignal,
): Promise<void> {
  const mode = deps.mode();
  const { cover, skipped } = await chooseCover(deps.fetcher, release, matches, mode, signal);
  let folderPath: string | null = null, folderCurrent: string | null = null;
  if (cover?.folder) {
    const name = folderFileName(cover.folder.mime);
    try {
      const abs = await folderCoverPath(await Deno.realPath(deps.musicDir), folder, name);
      folderCurrent = (await readFolderCover(abs))?.sha256 ?? null;
      folderPath = folder === "" ? name : `${folder}/${name}`;
    } catch (e) {
      // A linked cover file or an unreadable folder: the folder file is not proposed.
      skipped.push({ source: cover.source, reason: `folder image: ${(e as Error).message}` });
    }
  }
  saveCover(db, proposalId, {
    mode,
    source: cover?.source ?? null,
    skipped,
    embed: cover?.embed ?? null,
    folder: folderPath ? cover?.folder ?? null : null,
    embedStatus: cover?.embed ? embedStatus(cover.embed, files) : null,
    folderStatus: folderPath && cover?.folder ? folderStatus(folderCurrent, cover.folder.sha256) : null,
    folderPath,
    folderCurrent,
  });
}

/**
 * A proposal from a provider release (§10.4, D51): the linked release, the same
 * release on the other providers (by barcode, same track count only), merged by
 * Harmony with the linked provider first. No MusicBrainz data, so no MBIDs.
 */
async function proposeFromProvider(
  deps: ProposeJobDeps,
  url: URL,
  found: NonNullable<ReturnType<typeof getRelease>>,
  contentHash: string,
  now: () => number,
  signal?: AbortSignal,
): Promise<ProposeJobResult> {
  const enrichment = deps.enrichment;
  if (!enrichment) throw new PermanentJobError("no providers are set up");
  const primary = enrichment.registry.providerForUrl(url) as SourceProvider | undefined;
  if (!primary) throw new PermanentJobError(`no enabled provider handles ${url.hostname}`);
  let release: HarmonizedRelease;
  try {
    release = await lookupLink(enrichment, url, { ...LOOKUP_OPTIONS });
  } catch (e) {
    throw new PermanentJobError(`${url.hostname}: ${(e as Error).message}`.slice(0, 300));
  }
  const href = release.info?.providers?.[0]?.url ?? url.href;
  // The others by barcode; the linked provider is looked up again by its link (answered from Harmony's cache).
  const others = await findOnProviders(enrichment, targetOfHarmony(release), [href]);
  const matches: ProviderMatch[] = primary === "bandcamp"
    ? [{ provider: "bandcamp", status: "found", via: "link", url: href, reason: null, release }, ...others]
    : others.map((m) =>
      m.provider === primary ? { ...m, status: "found", via: "link", url: href, reason: null, release } : m
    );
  const primaryName = release.info.providers[0]?.name ?? primary;
  const releaseMap: Record<string, HarmonizedRelease> = { [primaryName]: release };
  for (const m of matches) {
    if (m.status !== "found" || !m.release || m.provider === primary) continue;
    releaseMap[m.release.info.providers[0]?.name ?? m.provider] = m.release;
  }
  const merged = mergeProviderReleases(releaseMap, primaryName);
  const proposed = tagsFromProviders(merged, primary);
  const youtube = await evidenceMatch(deps, found.release.id, targetOfHarmony(release).trackCount, signal);
  applyEvidence(proposed, youtube);
  if (youtube) matches.push(youtube);

  const files = found.files.filter((f) => !f.readError);
  const { mapping } = scoreRelease(
    buildEvidence(null, files),
    providerReleaseView(merged, href),
    DEFAULT_SCORING,
  );
  const build = buildFieldProposals({
    candidateId: found.release.id,
    files: files.map((f) => ({ id: f.id, tags: f.tags })),
    mapping: mapping.pairs,
    proposed,
    snapshotId: null,
    locks: listLocks(deps.db),
    provenance: proposed.provenance,
  });
  const proposalId = saveProposal(deps.db, {
    candidateId: found.release.id,
    releaseMbid: null,
    sourceUrl: href,
    chosenBy: "user",
    basedOnHash: contentHash,
    snapshotIds: [],
    build: {
      ...build,
      unmappedFiles: [...build.unmappedFiles, ...found.files.filter((f) => f.readError).map((f) => f.id)],
    },
  }, now());
  saveProviderMatches(deps.db, proposalId, matches, now());
  if (deps.covers) {
    const mappedIds = new Set(mapping.pairs.map((p) => p.fileId));
    await proposeCover(
      deps.db,
      deps.covers,
      proposalId,
      { id: "" },
      matches,
      found.release.folder,
      files.filter((f) => mappedIds.has(f.id)),
      signal,
    );
  }
  const count = (st: string) => build.fields.filter((f) => f.status === st).length;
  return {
    proposalId,
    changed: count("changed"),
    added: count("added"),
    unchanged: count("unchanged"),
    unmappedFiles: build.unmappedFiles.length,
  };
}

export function proposeDedupeKey(candidateId: number): string {
  return `${PROPOSE_JOB}:${candidateId}`;
}

export function enqueuePropose(
  queue: JobQueue,
  candidateId: number,
  releaseMbid: string,
  chosenBy: ChosenBy,
  server?: "https://test.musicbrainz.org",
): Job {
  return queue.enqueue(PROPOSE_JOB, { candidateId, releaseMbid, chosenBy, ...(server ? { server } : {}) }, {
    dedupeKey: proposeDedupeKey(candidateId),
    maxAttempts: 3,
  });
}

/** A proposal from a Deezer, iTunes, Discogs or Bandcamp link, for a release not on MusicBrainz (§10.4). */
export function enqueueProviderPropose(queue: JobQueue, candidateId: number, providerUrl: string): Job {
  return queue.enqueue(PROPOSE_JOB, { candidateId, providerUrl, chosenBy: "user" }, {
    dedupeKey: proposeDedupeKey(candidateId),
    maxAttempts: 3,
  });
}

/**
 * After a confident identification. Never replaces an unwritten proposal the
 * user chose: a rescan must not silently undo their pick (D40).
 */
export function autoPropose(db: Db, queue: JobQueue, candidateId: number, releaseMbid: string): Job | null {
  const latest = latestProposal(db, candidateId);
  if (latest && latest.chosenBy === "user" && latest.state !== "written" && latest.state !== "discarded") return null;
  return enqueuePropose(queue, candidateId, releaseMbid, "auto");
}

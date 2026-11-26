/**
 * Fingerprint evidence for identification (§8 order 4): fpcalc per file
 * (cached in library_file until the file changes), then an AcoustID lookup
 * (cached as a snapshot). Read-only towards the library.
 */
import type { Db } from "../db/db.ts";
import { getFingerprint, setAcoustidId, setFingerprint } from "../db/repo/library.ts";
import { Roots } from "../fs/safe_path.ts";
import type { Logger } from "../log.ts";
import type { AcoustIdClient } from "../providers/acoustid.ts";
import { FingerprintError, fingerprintFile } from "../tagio/mod.ts";
import type { FileEvidence } from "./types.ts";

export interface FileFingerprintMatch {
  /** Recording MBIDs AcoustID links to this file's fingerprint. */
  recordingIds: string[];
  /** Releases containing any of those recordings. */
  releaseIds: string[];
}

export interface FingerprintSource {
  /** Files that could not be fingerprinted or matched are absent from the map. */
  lookup(files: FileEvidence[], signal?: AbortSignal): Promise<Map<number, FileFingerprintMatch>>;
}

export interface AcoustIdSourceDeps {
  db: Db;
  acoustid: AcoustIdClient;
  musicDir: string;
  /** The inbox (D58): its albums are fingerprinted too. */
  inboxDir?: string | null;
  logger: Logger;
  /** AcoustID results below this score are ignored. */
  minScore?: number;
  fingerprint?: typeof fingerprintFile;
}

export function createAcoustIdSource(deps: AcoustIdSourceDeps): FingerprintSource {
  const minScore = deps.minScore ?? 0.5;
  const fingerprint = deps.fingerprint ?? fingerprintFile;
  return {
    async lookup(files, signal) {
      const out = new Map<number, FileFingerprintMatch>();
      // Resolved per run: the mount may appear after startup.
      const roots = await Roots.open(deps.musicDir, deps.inboxDir);
      for (const f of files) {
        signal?.throwIfAborted();
        let fp = getFingerprint(deps.db, f.fileId);
        if (!fp) {
          try {
            fp = await fingerprint(await roots.resolve(f.path), { signal });
          } catch (e) {
            if (!(e instanceof FingerprintError)) throw e;
            // Silence or very short tracks have no usable fingerprint; the other files still count.
            deps.logger.debug("no fingerprint", { path: f.path, error: e.message });
            continue;
          }
          setFingerprint(deps.db, f.fileId, fp);
        }
        const { value } = await deps.acoustid.lookup(fp.fingerprint, fp.durationSec, signal);
        const good = value.filter((r) => r.score >= minScore).sort((a, b) => b.score - a.score);
        setAcoustidId(deps.db, f.fileId, good[0]?.id ?? null);
        const recordings = good.flatMap((r) => r.recordings ?? []);
        if (recordings.length === 0) continue;
        out.set(f.fileId, {
          recordingIds: [...new Set(recordings.map((r) => r.id))],
          releaseIds: [...new Set(recordings.flatMap((r) => (r.releases ?? []).map((x) => x.id)))],
        });
      }
      return out;
    },
  };
}

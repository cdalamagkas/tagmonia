/**
 * Everything the release page shows, loaded together and kept live (D53): while any
 * job for the release runs (identification, building the proposal, a write or undo,
 * a submission check), the page polls, so results appear without a reload. Before,
 * each card polled only for jobs it already knew about, and an automatic proposal
 * made after identification never showed (problem 6 of the proposal).
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { CurrentCoverDto, ReleaseDetail } from "../../../shared/types.ts";
import { api, ApiRequestError } from "../api.ts";
import type { ReleaseState } from "./status.ts";

export interface LoadedRelease extends ReleaseState {
  detail: ReleaseDetail;
  cover: CurrentCoverDto | null;
  /** Bumped when the files changed (a write or undo finished), so the cover image is asked for again. */
  filesVersion: number;
}

const POLL_MS = 1500;

/** A job for this release is queued or running: keep polling. */
export function isLive(s: ReleaseState): boolean {
  return !!s.identification.job || s.identification.status === "identifying" || !!s.proposal.job ||
    !!s.history.job || s.submission?.state === "checking" || s.submission?.state === "verifying";
}

export function useRelease(id: number) {
  const [data, setData] = useState<LoadedRelease | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filesVersion = useRef(0);
  const last = useRef<LoadedRelease | null>(null);

  const load = async () => {
    try {
      const [detail, identification, proposal, history, sub, cover] = await Promise.all([
        api.release(id),
        api.identification(id),
        api.proposal(id),
        api.history(id),
        api.submission(id),
        api.coverInfo(id).then((r) => r.cover, () => null),
      ]);
      // A write or undo that just finished changed the files: their tags, sizes and cover.
      if (last.current?.history.job && !history.job) filesVersion.current++;
      const next: LoadedRelease = {
        detail,
        identification,
        proposal,
        history,
        submission: sub.submission,
        inInbox: detail.release.inInbox,
        cover,
        filesVersion: filesVersion.current,
      };
      last.current = next;
      setData(next);
      setError(null);
    } catch (e) {
      setError(
        e instanceof ApiRequestError && e.status === 404 ? "This release no longer exists." : (e as Error).message,
      );
    }
  };

  useEffect(() => {
    last.current = null;
    setData(null);
    load();
  }, [id]);

  useEffect(() => {
    if (!data || !isLive(data)) return;
    const t = setTimeout(load, POLL_MS);
    return () => clearTimeout(t);
  }, [data]);

  return { data, error, reload: load };
}

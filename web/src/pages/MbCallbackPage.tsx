/**
 * MusicBrainz's release editor redirects here after a submission, with the new
 * release's MBID (§12.2). The server verifies it with MusicBrainz before using it.
 */
import { useEffect, useState } from "preact/hooks";
import type { SubmissionDto } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { navigate, onLinkClick } from "../router.ts";

export function MbCallbackPage({ submission }: { submission: number }) {
  const [sub, setSub] = useState<SubmissionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mbid = new URLSearchParams(location.search).get("release_mbid");

  useEffect(() => {
    if (!mbid) return;
    api.submissionCallback(submission, mbid).then(setSub, (e) => setError((e as Error).message));
  }, [submission]);

  // Poll until MusicBrainz confirmed the release, then go to the release page, at the panel's last step.
  useEffect(() => {
    if (!sub || sub.state !== "verifying") return;
    const t = setTimeout(async () => {
      try {
        const s = (await api.submission(sub.candidateId)).submission;
        if (s) setSub(s);
      } catch (e) {
        setError((e as Error).message);
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [sub]);
  useEffect(() => {
    if (sub?.state === "returned") navigate(`/releases/${sub.candidateId}?panel=musicbrainz`);
  }, [sub?.state]);

  return (
    <main class="tm-narrow">
      <section class="tm-card">
        <h1>Back from MusicBrainz</h1>
        {!mbid && (
          <p class="tm-error">
            MusicBrainz did not send a release back. If you submitted it, paste its link on the release page.
          </p>
        )}
        {error && <p class="tm-error" role="alert">{error}</p>}
        {mbid && !error && (!sub || sub.state === "verifying") && (
          <p class="tm-muted">Checking release {mbid} on MusicBrainz…</p>
        )}
        {sub && sub.state === "seeded" && sub.error && <p class="tm-error">{sub.error}</p>}
        {sub && (
          <p>
            <a href={`/releases/${sub.candidateId}`} onClick={onLinkClick}>Back to the release</a>
          </p>
        )}
      </section>
    </main>
  );
}

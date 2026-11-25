import { useEffect, useState } from "preact/hooks";
import type { CurrentCoverDto, LibraryFileDto, ReleaseDetail } from "../../../shared/types.ts";
import { api, ApiRequestError } from "../api.ts";
import { bytes, duration, RELEASE_FIELDS, tagValue } from "../format.ts";
import { onLinkClick } from "../router.ts";
import { Identification } from "../components/Identification.tsx";
import { Review } from "../components/Review.tsx";
import { CoverImage } from "../components/CoverImage.tsx";
import { Submission } from "../components/Submission.tsx";

function coverCaption(c: CurrentCoverDto): string {
  const kb = c.size >= 1024 * 1024 ? `${(c.size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(c.size / 1024)} KB`;
  const type = c.mime === "image/png"
    ? "PNG"
    : c.mime === "image/jpeg"
    ? "JPEG"
    : c.mime.replace("image/", "").toUpperCase();
  const dims = c.width && c.height ? `${c.width} × ${c.height} ` : "";
  const where = c.kind === "embedded"
    ? `embedded in ${c.filesWithPicture} of ${c.files} files`
    : `folder image ${c.path.split("/").pop()}${c.filesWithPicture ? "" : ", none embedded"}`;
  return `${dims}${type}, ${kb} · ${where}`;
}

function releaseTags(files: LibraryFileDto[]) {
  return RELEASE_FIELDS.flatMap((field) => {
    const values = files.map((f) => tagValue(f.tags[field]));
    const distinct = [...new Set(values)];
    if (distinct.length === 1 && distinct[0] === "") return [];
    return [{ field, distinct, missing: values.filter((v) => v === "").length }];
  });
}

function FileTags({ file }: { file: LibraryFileDto }) {
  const entries = Object.entries(file.tags).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div class="tm-file-detail">
      <p class="tm-path">{file.path}</p>
      <p class="tm-muted">
        {[
          file.format?.toUpperCase(),
          file.sampleRate && `${file.sampleRate / 1000} kHz`,
          file.channels && `${file.channels} ch`,
          file.bitrateKbps && `${file.bitrateKbps} kbps`,
          bytes(file.sizeBytes),
          file.pictures.length ? `${file.pictures.length} embedded picture(s)` : "no embedded picture",
        ].filter(Boolean).join(" · ")}
      </p>
      {entries.length === 0 ? <p class="tm-muted">No tags.</p> : (
        <dl class="tm-tags">
          {entries.map(([k, v]) => (
            <>
              <dt>{k}</dt>
              <dd>{tagValue(v)}</dd>
            </>
          ))}
        </dl>
      )}
    </div>
  );
}

export function ReleasePage({ id }: { id: number }) {
  const [data, setData] = useState<ReleaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const [version, setVersion] = useState(0);
  const [cover, setCover] = useState<CurrentCoverDto | null | undefined>(undefined);
  const [coverVersion, setCoverVersion] = useState(0);
  const reload = () => {
    // The files may have changed (a write or undo): ask for the cover again too.
    setCoverVersion((v) => v + 1);
    api.coverInfo(id).then((r) => setCover(r.cover), () => setCover(null));
    return api.release(id).then(
      setData,
      (e) => setError(e instanceof ApiRequestError && e.status === 404 ? "This release no longer exists." : e.message),
    );
  };
  useEffect(() => {
    setData(null);
    reload();
  }, [id]);

  if (error) {
    return (
      <main>
        <a href="/" onClick={onLinkClick}>← Library</a>
        <p class="tm-error">{error}</p>
      </main>
    );
  }
  if (!data) {
    return (
      <main>
        <p class="tm-muted">Loading…</p>
      </main>
    );
  }

  const { release, files } = data;
  const multiDisc = new Set(files.map((f) => f.tags.discnumber ?? 1)).size > 1;
  return (
    <main>
      <a href="/" onClick={onLinkClick}>← Library</a>
      <section class="tm-card">
        <div class="tm-release-head">
          <figure class="tm-release-cover">
            <CoverImage
              releaseId={release.id}
              size="large"
              px={200}
              version={coverVersion}
              alt={`Cover of ${release.album ?? "this release"}`}
            />
            <figcaption class="tm-muted">
              {cover === undefined ? "" : cover ? coverCaption(cover) : "No cover in the files or the folder."}
            </figcaption>
          </figure>
          <div>
            <h1>{release.album ?? "Loose files"}</h1>
            <p class="tm-muted">
              {release.artist ?? "Unknown artist"} · {release.trackCount} files ·{" "}
              <span class="tm-path">{release.folder || "/"}</span>
            </p>
          </div>
        </div>
        <h2>Release tags</h2>
        <table class="tm-table tm-kv">
          <tbody>
            {releaseTags(files).map(({ field, distinct, missing }) => (
              <tr key={field}>
                <th>{field}</th>
                <td>
                  {distinct.length === 1 && missing === 0 ? distinct[0] : (
                    <>
                      <span class="tm-badge tm-badge-warn">differs across files</span>
                      <ul class="tm-values">
                        {distinct.map((v) => <li key={v}>{v || <span class="tm-muted">(not set)</span>}</li>)}
                      </ul>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <Identification
        releaseId={release.id}
        files={files}
        onChoose={async (releaseMbid) => {
          await api.propose(release.id, { releaseMbid });
          setVersion((v) => v + 1);
        }}
        onChooseProvider={async (providerUrl) => {
          await api.propose(release.id, { providerUrl });
          setVersion((v) => v + 1);
        }}
      />
      <Review releaseId={release.id} files={files} version={version} onFilesChanged={reload} />
      <Submission releaseId={release.id} version={version} onProposalChanged={() => setVersion((v) => v + 1)} />

      <section class="tm-card">
        <h2>Tracks</h2>
        <div class="tm-table-wrap">
          <table class="tm-table">
            <thead>
              <tr>
                <th class="tm-num tm-col-narrow">#</th>
                <th>Title</th>
                <th>Artist</th>
                <th class="tm-num">Length</th>
                <th>Format</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <>
                  <tr
                    key={f.id}
                    class={`tm-clickable${open === f.id ? " tm-open" : ""}`}
                    onClick={() => setOpen(open === f.id ? null : f.id)}
                  >
                    <td class="tm-num tm-col-narrow">
                      {multiDisc && f.tags.discnumber ? `${f.tags.discnumber}-` : ""}
                      {f.tags.tracknumber ?? ""}
                    </td>
                    <td>
                      <button type="button" class="tm-linklike" aria-expanded={open === f.id}>
                        {f.tags.title ?? <span class="tm-muted">{f.path.split("/").pop()}</span>}
                      </button>
                      {f.readError && <span class="tm-badge tm-badge-error" title={f.readError}>unreadable</span>}
                    </td>
                    <td>{f.tags.artist ?? ""}</td>
                    <td class="tm-num">{duration(f.durationMs)}</td>
                    <td>{f.format ?? "–"}</td>
                  </tr>
                  {open === f.id && (
                    <tr key={`${f.id}-detail`} class="tm-detail-row">
                      <td colSpan={5}>
                        {f.readError && <p class="tm-error">{f.readError}</p>}
                        <FileTags file={f} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

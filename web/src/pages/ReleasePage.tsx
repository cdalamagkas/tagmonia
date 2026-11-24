import { useEffect, useState } from "preact/hooks";
import type { LibraryFileDto, ReleaseDetail } from "../../../shared/types.ts";
import { api, ApiRequestError } from "../api.ts";
import { bytes, duration, RELEASE_FIELDS, tagValue } from "../format.ts";
import { onLinkClick } from "../router.ts";
import { Identification } from "../components/Identification.tsx";
import { Review } from "../components/Review.tsx";

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
  const reload = () =>
    api.release(id).then(
      setData,
      (e) => setError(e instanceof ApiRequestError && e.status === 404 ? "This release no longer exists." : e.message),
    );
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
        <h1>{release.album ?? "Loose files"}</h1>
        <p class="tm-muted">
          {release.artist ?? "Unknown artist"} · {release.trackCount} files ·{" "}
          <span class="tm-path">{release.folder || "/"}</span>
        </p>
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
      />
      <Review releaseId={release.id} files={files} version={version} onFilesChanged={reload} />

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

/** A release's current cover (D50), or a quiet placeholder when it has none. */
import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";

export function CoverImage(
  { releaseId, size, px, version = 0, alt }: {
    releaseId: number;
    /** "thumb" (160 px) for lists, "large" (600 px) for the release page. */
    size: "thumb" | "large";
    /** Displayed edge length in CSS pixels. */
    px: number;
    /** Bumped after a write, so the browser asks again (the server answers 304 when nothing changed). */
    version?: number;
    alt: string;
  },
) {
  const [missing, setMissing] = useState(false);
  useEffect(() => setMissing(false), [releaseId, version]);
  if (missing) {
    return (
      <span class="tm-cover-thumb tm-cover-empty" style={{ width: `${px}px`, height: `${px}px` }} aria-hidden="true">
        ♪
      </span>
    );
  }
  return (
    <img
      class="tm-cover-thumb"
      src={api.coverUrl(releaseId, size, version)}
      alt={alt}
      width={px}
      height={px}
      loading="lazy"
      decoding="async"
      onError={() => setMissing(true)}
    />
  );
}

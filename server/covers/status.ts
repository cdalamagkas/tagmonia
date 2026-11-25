/** How a proposed cover compares with what the release has now (D49). Pure. */

export type CoverStatus = "added" | "changed" | "unchanged";

/**
 * Embedded covers are compared by type, MIME type and byte length, from the
 * scanner's picture metadata (it reads no image bytes, D24). Identical length
 * and type for a different image is unlikely enough; at worst a cover that
 * differs is shown as already right and left alone.
 */
export function embedStatus(
  image: { mime: string; size: number },
  files: { pictures: { type: string; mime: string; size: number }[] }[],
): CoverStatus {
  const fronts = files.map((f) => f.pictures.find((p) => p.type === "front"));
  if (fronts.every((p) => !p)) return "added";
  if (fronts.every((p) => p && p.mime === image.mime && p.size === image.size)) return "unchanged";
  return "changed";
}

export function folderStatus(currentSha: string | null, sha: string): CoverStatus {
  return currentSha === null ? "added" : currentSha === sha ? "unchanged" : "changed";
}

/** The folder file's name: cover.jpg, or cover.png for a PNG (what Jellyfin and Navidrome look for). */
export function folderFileName(mime: string): string {
  return mime === "image/png" ? "cover.png" : "cover.jpg";
}

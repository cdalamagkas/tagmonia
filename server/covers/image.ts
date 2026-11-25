/**
 * Image facts from the header bytes (§14: MIME sniffing for downloads). Pure.
 * Only JPEG and PNG are accepted for new covers (D11): every format embeds them,
 * MP4 `covr` takes nothing else.
 */

export interface ImageInfo {
  mime: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** JPEG start-of-frame markers carry the dimensions; DHT (C4), JPG (C8) and DAC (CC) do not. */
function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

export function imageInfo(b: Uint8Array): ImageInfo | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && PNG_MAGIC.every((v, i) => b[i] === v)) {
    // The first chunk is IHDR: width and height as big-endian u32.
    if (String.fromCharCode(...b.subarray(12, 16)) !== "IHDR") return null;
    const width = view.getUint32(16), height = view.getUint32(20);
    return width && height ? { mime: "image/png", width, height } : null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { // fill byte
        i++;
        continue;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const len = view.getUint16(i + 2);
      if (len < 2) return null;
      if (isSof(marker)) {
        if (i + 9 > b.length) return null;
        const height = view.getUint16(i + 5), width = view.getUint16(i + 7);
        return width && height ? { mime: "image/jpeg", width, height } : null;
      }
      if (marker === 0xda || marker === 0xd9) return null; // image data before any frame header
      i += 2 + len;
    }
  }
  return null;
}

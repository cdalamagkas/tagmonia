/** Synthetic images for cover tests: valid headers with the given size; nobody decodes the pixels. */

/** A JPEG header (SOI, APP0, SOF0) with `w`×`h`, padded with `seed` bytes so different images differ. */
export function fakeJpeg(w: number, h: number, seed = 0, padding = 64): Uint8Array<ArrayBuffer> {
  const app0 = [
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
  ];
  const sof0 = [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    h >> 8,
    h & 0xff,
    w >> 8,
    w & 0xff,
    0x03,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  const body = Array.from({ length: padding }, (_, i) => (seed * 31 + i) & 0x7f);
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, ...body, 0xff, 0xd9]);
}

/** A PNG signature and IHDR chunk with `w`×`h`. */
export function fakePng(w: number, h: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  b.set([8, 2, 0, 0, 0], 24);
  return b;
}

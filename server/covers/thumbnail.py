"""Cover thumbnails (D50): image bytes on stdin, a JPEG no larger than MAX x MAX px on stdout.

Usage: python3 -I thumbnail.py MAX
Exit 2: not an image Pillow can read safely (the caller falls back or gives up).
"""
import io
import sys
import warnings

from PIL import Image

# Covers are at most a few thousand pixels a side; anything far larger is a decompression bomb.
Image.MAX_IMAGE_PIXELS = 64_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)


def main() -> int:
    size = int(sys.argv[1])
    if not 16 <= size <= 2000:
        return 2
    data = sys.stdin.buffer.read()
    try:
        img = Image.open(io.BytesIO(data))
        img.draft("RGB", (size, size))  # JPEG: decode at a reduced scale, much faster for big covers
        img.thumbnail((size, size), Image.Resampling.LANCZOS)
        if img.mode not in ("RGB", "L"):
            bg = Image.new("RGB", img.size, (255, 255, 255))
            rgba = img.convert("RGBA")
            bg.paste(rgba, mask=rgba.getchannel("A"))
            img = bg
        out = io.BytesIO()
        img.save(out, "JPEG", quality=85, optimize=True, progressive=True)
    except Exception:  # noqa: BLE001 - any decoding problem means "no thumbnail"
        return 2
    sys.stdout.buffer.write(out.getvalue())
    return 0


if __name__ == "__main__":
    sys.exit(main())

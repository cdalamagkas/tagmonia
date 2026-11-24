#!/usr/bin/env python3
"""Generate TagIO conformance fixtures (ARCHITECTURE.md §11.5).

Runs inside the dev container (scripts/dk). Audio is a 2 s generated tone, so
nothing copyrighted is involved. mutagen acts as the reference writer, writing
tags the way Picard does (Picard itself is built on mutagen).

Usage: generate_audio.py <mapping.json> <fixture_tags.json> <out_dir>
"""
import base64, json, os, subprocess, sys

from mutagen.flac import FLAC, Picture
from mutagen.oggvorbis import OggVorbis
from mutagen.oggopus import OggOpus
from mutagen.id3 import ID3, TXXX, UFID, TIPL, TMCL, APIC, COMM, PRIV, Frames
from mutagen.mp4 import MP4, MP4Cover, MP4FreeForm

FORMATS = {
    "flac": ["-c:a", "flac"],
    "ogg": ["-c:a", "libvorbis", "-q:a", "0"],
    "opus": ["-c:a", "libopus", "-b:a", "32k"],
    "mp3": ["-c:a", "libmp3lame", "-b:a", "64k"],
    "m4a": ["-c:a", "aac", "-b:a", "64k"],
}
UNKNOWN_KEY = "TAGMONIA_UNKNOWN_FIELD"
UNKNOWN_VALUES = ["keep me", "and me"]


def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def gen_audio(out, ext):
    run("ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-ac", "2", "-map_metadata", "-1", *FORMATS[ext], out)


def gen_images(out_dir):
    front = os.path.join(out_dir, "cover-front.png")
    back = os.path.join(out_dir, "cover-back.jpg")
    run("ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=0x1b2a4a:s=64x64", "-frames:v", "1", front)
    run("ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=0xe0a030:s=48x48", "-frames:v", "1", back)
    return open(front, "rb").read(), open(back, "rb").read()


def values(kind, v):
    if kind == "multi":
        return list(v)
    if kind == "int":
        return [str(v)]
    return [v]


def vorbis_items(mapping, tags):
    items = []
    for m in mapping:
        f = m["field"]
        if f not in tags:
            continue
        if m["kind"] == "performer":
            for role, names in tags[f].items():
                for n in names:
                    items.append((m["vorbis"][0], f"{n} ({role})"))
            continue
        for key in m["vorbis"]:
            for v in values(m["kind"], tags[f]):
                items.append((key, v))
    return items


def flac_picture(data, mime, ptype, desc):
    p = Picture()
    p.type, p.mime, p.desc, p.data = ptype, mime, desc, data
    p.width = p.height = 64 if ptype == 3 else 48
    p.depth = 24
    return p


def write_vorbis(path, ext, mapping, tags, front, back):
    f = {"flac": FLAC, "ogg": OggVorbis, "opus": OggOpus}[ext](path)
    if f.tags is None:
        f.add_tags()
    for k, v in vorbis_items(mapping, tags):
        f.tags[k] = (f.tags.get(k) or []) + [v]
    f.tags[UNKNOWN_KEY] = UNKNOWN_VALUES
    f.tags["COMMENT"] = ["a comment"]
    pics = [flac_picture(front, "image/png", 3, "front"), flac_picture(back, "image/jpeg", 4, "back")]
    if ext == "flac":
        for p in pics:
            f.add_picture(p)
    else:
        f.tags["METADATA_BLOCK_PICTURE"] = [base64.b64encode(p.write()).decode("ascii") for p in pics]
    f.save()


def write_id3(path, mapping, tags, front, back, version=4):
    id3 = ID3()
    pairs = {"track": [None, None], "disc": [None, None], "movement": [None, None]}
    # Picard keeps arranger in TIPL next to other involvement roles; the extra
    # producer entry lets the suite check that writing arranger leaves it alone.
    tipl = [["producer", "Producer One"]]
    for m in mapping:
        f = m["field"]
        if f not in tags:
            continue
        frame, kind = m["id3"], m["kind"]
        if m.get("pair"):
            pairs[m["pair"]["group"]][m["pair"]["index"]] = tags[f]
        elif kind == "performer":
            people = [[role, n] for role, names in tags[f].items() for n in names]
            id3.add(TMCL(encoding=3, people=people))
        elif frame.startswith("TXXX:"):
            id3.add(TXXX(encoding=3, desc=frame[5:], text=values(kind, tags[f])))
        elif frame.startswith("UFID:"):
            id3.add(UFID(owner=frame[5:], data=tags[f].encode("ascii")))
        elif frame.startswith("TIPL:"):
            tipl += [[frame[5:], n] for n in values(kind, tags[f])]
        else:
            id3.add(Frames[frame](encoding=3, text=values(kind, tags[f])))
    id3.add(TIPL(encoding=3, people=tipl))
    for group, fid in (("track", "TRCK"), ("disc", "TPOS"), ("movement", "MVIN")):
        n, total = pairs[group]
        if n is not None:
            id3.add(Frames[fid](encoding=3, text=[f"{n}/{total}" if total else str(n)]))
    id3.add(TXXX(encoding=3, desc=UNKNOWN_KEY, text=UNKNOWN_VALUES))
    id3.add(COMM(encoding=3, lang="eng", desc="", text=["a comment"]))
    id3.add(PRIV(owner="tagmonia-test", data=b"\x00\x01binary\xff"))
    id3.add(APIC(encoding=3, mime="image/png", type=3, desc="front", data=front))
    id3.add(APIC(encoding=3, mime="image/jpeg", type=4, desc="back", data=back))
    # v2.3 has no multi-value frames; mutagen joins with '/' like Picard's default.
    id3.save(path, v2_version=version, v23_sep="/")


def write_mp4(path, mapping, tags, front, back):
    f = MP4(path)
    if f.tags is None:
        f.add_tags()
    pairs = {"trkn": [0, 0], "disk": [0, 0]}
    for m in mapping:
        fld, atom = m["field"], m["mp4"]
        if fld not in tags or atom is None:
            continue
        if m.get("mp4Pair"):
            pairs[atom][m["pair"]["index"]] = tags[fld]
        elif atom.startswith("----:"):
            f.tags[atom] = [MP4FreeForm(v.encode("utf-8")) for v in values(m["kind"], tags[fld])]
        elif m["kind"] == "int":
            f.tags[atom] = [int(tags[fld])]
        else:
            f.tags[atom] = values(m["kind"], tags[fld])
    for atom, (n, total) in pairs.items():
        if n:
            f.tags[atom] = [(n, total)]
    f.tags["----:com.apple.iTunes:" + UNKNOWN_KEY] = [MP4FreeForm(v.encode()) for v in UNKNOWN_VALUES]
    f.tags["----:org.example.tagmonia:custom-mean"] = [MP4FreeForm(b"other mean")]
    f.tags["\xa9cmt"] = ["a comment"]
    f.tags["covr"] = [MP4Cover(front, MP4Cover.FORMAT_PNG), MP4Cover(back, MP4Cover.FORMAT_JPEG)]
    f.save()


def main():
    mapping = json.load(open(sys.argv[1]))
    tags = json.load(open(sys.argv[2]))
    out_dir = sys.argv[3]
    os.makedirs(out_dir, exist_ok=True)
    front, back = gen_images(out_dir)
    for ext in FORMATS:
        blank = os.path.join(out_dir, f"blank.{ext}")
        tagged = os.path.join(out_dir, f"tagged.{ext}")
        gen_audio(blank, ext)
        gen_audio(tagged, ext)
        if ext in ("flac", "ogg", "opus"):
            write_vorbis(tagged, ext, mapping, tags, front, back)
        elif ext == "mp3":
            write_id3(tagged, mapping, tags, front, back)
            v23 = os.path.join(out_dir, "tagged-v23.mp3")
            gen_audio(v23, ext)
            write_id3(v23, mapping, tags, front, back, version=3)
        else:
            write_mp4(tagged, mapping, tags, front, back)
    print(f"fixtures written to {out_dir}")


if __name__ == "__main__":
    main()

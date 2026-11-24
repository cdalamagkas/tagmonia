#!/usr/bin/env python3
"""Independent raw tag inspector for the TagIO conformance suite.

Prints a JSON description of the native tag structures in an audio file, using
mutagen and (for MP4) a byte-level walk of moov/udta/meta/ilst, so tests can
assert on-disk layout without trusting the implementation under test.
"""
import base64, json, struct, sys

import mutagen
from mutagen.flac import FLAC, Picture
from mutagen.id3 import ID3
from mutagen.mp4 import Atoms


def pic(p, via):
    return {"via": via, "type": p.type, "mime": p.mime, "desc": p.desc, "size": len(p.data),
            "sha": __import__("hashlib").sha256(p.data).hexdigest()}


def vorbis(f, path):
    out = {"kind": "vorbis", "comments": [], "pictures": []}
    for k, v in (f.tags or []):
        if k.upper() == "METADATA_BLOCK_PICTURE":
            out["pictures"].append(pic(Picture(base64.b64decode(v)), "METADATA_BLOCK_PICTURE"))
        else:
            out["comments"].append([k, v])
    if isinstance(f, FLAC):
        out["pictures"] += [pic(p, "PICTURE") for p in f.pictures]
    return out


def id3(path):
    t = ID3(path)
    frames = []
    for fr in t.values():
        d = {"id": fr.FrameID, "hash": fr.HashKey}
        if fr.FrameID == "TXXX":
            d.update(desc=fr.desc, text=[str(x) for x in fr.text])
        elif fr.FrameID == "UFID":
            d.update(owner=fr.owner, data=fr.data.decode("latin-1"))
        elif fr.FrameID in ("TMCL", "TIPL"):
            d.update(people=[list(p) for p in fr.people])
        elif fr.FrameID == "APIC":
            d.update(type=int(fr.type), mime=fr.mime, desc=fr.desc, size=len(fr.data))
        elif fr.FrameID == "PRIV":
            d.update(owner=fr.owner, data=fr.data.hex())
        elif fr.FrameID == "COMM":
            d.update(desc=fr.desc, lang=fr.lang, text=[str(x) for x in fr.text])
        elif hasattr(fr, "text"):
            d.update(text=[str(x) for x in fr.text])
        frames.append(d)
    return {"kind": "id3", "version": list(t.version), "frames": frames}


def subatoms(buf):
    i = 0
    while i + 8 <= len(buf):
        size, name = struct.unpack(">I4s", buf[i:i + 8])
        if size < 8:
            break
        yield name, buf[i + 8:i + size]
        i += size


def mp4(path):
    with open(path, "rb") as fh:
        atoms = Atoms(fh)
        ilst = atoms.path(b"moov", b"udta", b"meta", b"ilst")[-1]
        fh.seek(ilst.offset + 8)
        body = fh.read(ilst.length - 8)
    items = []
    for name, payload in subatoms(body):
        key = name.decode("latin-1")
        data = []
        mean = nm = None
        for sname, sbody in subatoms(payload):
            if sname == b"mean":
                mean = sbody[4:].decode("utf-8")
            elif sname == b"name":
                nm = sbody[4:].decode("utf-8")
            elif sname == b"data":
                dtype = struct.unpack(">I", sbody[0:4])[0] & 0xFFFFFF
                raw = sbody[8:]
                if key in ("trkn", "disk"):
                    data.append(list(struct.unpack(">HHH", raw[:6]))[1:] if len(raw) >= 6 else raw.hex())
                elif key == "covr":
                    data.append({"dtype": dtype, "size": len(raw)})
                elif dtype == 1:
                    data.append(raw.decode("utf-8"))
                elif dtype == 21:  # iTunes big-endian signed integer (©mvi, ©mvc, shwm)
                    data.append(int.from_bytes(raw, "big", signed=True))
                else:
                    data.append({"dtype": dtype, "hex": raw.hex()})
        if key == "----":
            key = f"----:{mean}:{nm}"
        items.append({"key": key, "values": data})
    return {"kind": "mp4", "items": items}


def main():
    path = sys.argv[1]
    f = mutagen.File(path)
    name = type(f).__name__
    if name in ("FLAC", "OggVorbis", "OggOpus"):
        out = vorbis(f, path)
    elif name in ("MP3", "EasyMP3"):
        out = id3(path)
    elif name in ("MP4", "EasyMP4"):
        out = mp4(path)
    else:
        raise SystemExit(f"unsupported: {name}")
    out["length"] = f.info.length
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()

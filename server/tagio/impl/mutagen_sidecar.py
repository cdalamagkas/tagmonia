#!/usr/bin/env python3
"""Tagmonia TagIO sidecar (ARCHITECTURE.md §11.4, option B; Decision log D7).

Speaks newline-delimited JSON on stdin/stdout. The first message must be
{"op": "init", "mapping": [...]} carrying server/tagio/mapping.ts, so the field
mapping has a single source of truth.

This process edits the file path it is given *in place*. Atomicity (temp copy,
fsync, rename) is the caller's job (server/tagio/atomic.ts): it hands us a temp
copy, never the original.

Requests:  {"id": n, "op": "read", "path": str, "pictureData"?: bool}
           {"id": n, "op": "write", "path": str, "change": {set, remove, pictures?}}
Responses: {"id": n, "ok": true, "result": ...} | {"id": n, "ok": false, "error": str}
"""
import base64
import json
import os
import re
import sys
import traceback

import mutagen
from mutagen.flac import FLAC, Picture as FlacPicture
from mutagen.id3 import APIC, ID3, ID3NoHeaderError, TIPL, TMCL, TXXX, UFID, Frames
from mutagen.mp4 import MP4, MP4Cover, MP4FreeForm
from mutagen.oggopus import OggOpus
from mutagen.oggvorbis import OggVorbis

MAPPING = []
PIC_TYPES = {3: "front", 4: "back"}
PIC_CODES = {"front": 3, "back": 4, "other": 0}
FAULT = os.environ.get("TAGMONIA_TAGIO_FAULT", "")
# Per-request: the scanner only needs picture metadata, not megabytes of base64 per file.
READ_PICTURE_DATA = True


class UserError(Exception):
    pass


# ---------------------------------------------------------------- helpers

def fmt_of(f):
    if isinstance(f, FLAC):
        return "flac"
    if isinstance(f, OggOpus):
        return "opus"
    if isinstance(f, OggVorbis):
        return "ogg"
    if isinstance(f, MP4):
        return "m4a"
    if type(f).__name__ == "MP3":
        return "mp3"
    raise UserError(f"unsupported file type: {type(f).__name__}")


def open_file(path):
    f = mutagen.File(path)
    if f is None:
        raise UserError("not a recognised audio file")
    return f, fmt_of(f)


def parse_int(s):
    m = re.match(r"\s*(\d+)", str(s))
    return int(m.group(1)) if m else None


def parse_pair(s):
    """'3/12' -> (3, 12); '3' -> (3, None)."""
    parts = str(s).split("/", 1)
    n = parse_int(parts[0]) if parts[0].strip() else None
    t = parse_int(parts[1]) if len(parts) > 1 and parts[1].strip() else None
    return n, t


def parse_vorbis_performer(v):
    m = re.match(r"^(.*\S)\s+\(([^()]+)\)$", v.strip())
    return (m.group(1), m.group(2).lower()) if m else (v.strip(), "")


def b64(data):
    return base64.b64encode(data).decode("ascii")


def out_picture(ptype, mime, data, desc):
    return {"type": PIC_TYPES.get(ptype, "other"), "mime": mime, "data": b64(data) if READ_PICTURE_DATA else "",
            "size": len(data), "description": desc or ""}


def shape(m, values):
    """Native string list -> canonical value for this mapping kind."""
    values = [v for v in values if v is not None and v != ""]
    if not values:
        return None
    if m["kind"] == "multi":
        return values
    if m["kind"] == "int":
        return parse_int(values[0])
    return values[0]


def pair_fields():
    """ID3 pair frame -> (number field, total field), e.g. MVIN -> (movementnumber, movementtotal)."""
    out = {}
    for m in MAPPING:
        if m.get("pair"):
            out.setdefault(m["id3"], [None, None])[m["pair"]["index"]] = m["field"]
    return out


def as_list(m, value):
    if m["kind"] == "multi":
        return [str(v) for v in value]
    return [str(value)]


# ---------------------------------------------------------------- vorbis (FLAC, OGG, Opus)

def vorbis_get(tags, key):
    try:
        return list(tags[key])  # mutagen VComment lookups are case-insensitive
    except KeyError:
        return []


def vorbis_read(f):
    tags = f.tags or {}
    out = {}
    for m in MAPPING:
        if m["kind"] == "performer":
            perf = {}
            for v in vorbis_get(tags, "PERFORMER"):
                name, role = parse_vorbis_performer(v)
                perf.setdefault(role, []).append(name)
            if perf:
                out[m["field"]] = perf
            continue
        vals = []
        for key in m["vorbis"]:
            vals = vorbis_get(tags, key)
            if vals:
                break
        if m.get("pair") and m["pair"]["index"] == 0 and vals:
            # Some taggers write TRACKNUMBER=3/12.
            n, t = parse_pair(vals[0])
            if n is not None:
                out[m["field"]] = n
            continue
        v = shape(m, vals)
        if v is not None:
            out[m["field"]] = v
    # Fill totals from "n/total" numbers when no explicit total tag exists.
    for num_key, field in (("TRACKNUMBER", "totaltracks"), ("DISCNUMBER", "totaldiscs"),
                           ("MOVEMENT", "movementtotal")):
        if field not in out:
            for v in vorbis_get(tags, num_key):
                _, t = parse_pair(v)
                if t is not None:
                    out[field] = t
    pics = []
    if isinstance(f, FLAC):
        pics = [out_picture(p.type, p.mime, p.data, p.desc) for p in f.pictures]
    else:
        for v in vorbis_get(tags, "METADATA_BLOCK_PICTURE"):
            try:
                p = FlacPicture(base64.b64decode(v))
                pics.append(out_picture(p.type, p.mime, p.data, p.desc))
            except Exception:
                pass  # corrupt picture block: ignore on read, preserved on write
    raw = {}
    for k, v in tags:
        if k.upper() != "METADATA_BLOCK_PICTURE":
            raw.setdefault(k.upper(), []).append(v)
    return out, pics, raw


def vorbis_write(f, change):
    if f.tags is None:
        f.add_tags()
    tags = f.tags
    for m in MAPPING:
        fld = m["field"]
        if fld not in change["set"] and fld not in change["remove"]:
            continue
        keys = m["vorbis"]
        for key in keys:
            if key in tags:
                del tags[key]
        if fld in change["remove"]:
            continue
        value = change["set"][fld]
        if m["kind"] == "performer":
            tags["PERFORMER"] = [f"{n} ({role})" for role, names in value.items() for n in names]
        else:
            for key in keys:
                tags[key] = as_list(m, value)
    if "pictures" in change:
        pics = [flac_picture(p) for p in change["pictures"]]
        if isinstance(f, FLAC):
            f.clear_pictures()
            for p in pics:
                f.add_picture(p)
        else:
            if "METADATA_BLOCK_PICTURE" in tags:
                del tags["METADATA_BLOCK_PICTURE"]
            if pics:
                tags["METADATA_BLOCK_PICTURE"] = [b64(p.write()) for p in pics]


def flac_picture(p):
    fp = FlacPicture()
    fp.type = PIC_CODES[p["type"]]
    fp.mime = p["mime"]
    fp.desc = p.get("description") or ""
    fp.data = base64.b64decode(p["data"])
    return fp


# ---------------------------------------------------------------- ID3 (MP3)

def id3_txxx(tags, desc):
    """TXXX frames matching desc case-insensitively (other taggers vary the case)."""
    d = desc.lower()
    return [fr for fr in tags.getall("TXXX") if fr.desc.lower() == d]


def id3_values(tags, spec):
    if spec.startswith("TXXX:"):
        return [str(t) for fr in id3_txxx(tags, spec[5:]) for t in fr.text]
    if spec.startswith("UFID:"):
        return [fr.data.decode("ascii", "replace") for fr in tags.getall("UFID") if fr.owner == spec[5:]]
    if spec.startswith("TIPL:"):
        role = spec[5:].lower()
        return [name for fr in tags.getall("TIPL") for r, name in fr.people if r.lower() == role]
    return [str(t) for fr in tags.getall(spec) for t in fr.text]


def id3_read(f):
    tags = f.tags
    out, pics, raw = {}, [], {}
    if tags is None:
        return out, pics, raw
    for m in MAPPING:
        spec = m["id3"]
        if m["kind"] == "performer":
            perf = {}
            for fr in tags.getall("TMCL"):
                for role, name in fr.people:
                    perf.setdefault(role.lower(), []).append(name)
            if perf:
                out[m["field"]] = perf
            continue
        vals = id3_values(tags, spec)
        if m.get("pair"):
            if vals:
                pair = parse_pair(vals[0])
                v = pair[m["pair"]["index"]]
                if v is not None:
                    out[m["field"]] = v
            continue
        v = shape(m, vals)
        if v is not None:
            out[m["field"]] = v
    for fr in tags.getall("APIC"):
        pics.append(out_picture(int(fr.type), fr.mime, fr.data, fr.desc))
    for fr in tags.values():
        if hasattr(fr, "text"):
            raw.setdefault(fr.HashKey, []).extend(str(t) for t in fr.text)
        elif fr.FrameID == "UFID":
            raw.setdefault(fr.HashKey, []).append(fr.data.decode("ascii", "replace"))
    return out, pics, raw


def id3_delete(tags, spec):
    if spec.startswith("TXXX:"):
        for fr in id3_txxx(tags, spec[5:]):
            tags.delall(fr.HashKey)
    elif spec.startswith("UFID:"):
        tags.delall("UFID:" + spec[5:])
    elif spec.startswith("TIPL:"):
        # TIPL is shared with producer, engineer and mix credits: drop only this role's entries.
        role = spec[5:].lower()
        for fr in tags.getall("TIPL"):
            fr.people = [p for p in fr.people if p[0].lower() != role]
        if not any(fr.people for fr in tags.getall("TIPL")):
            tags.delall("TIPL")
    else:
        tags.delall(spec)


def id3_write(f, change, current):
    if f.tags is None:
        f.add_tags()
    tags = f.tags
    pairs = {}
    for m in MAPPING:
        fld, spec = m["field"], m["id3"]
        if fld not in change["set"] and fld not in change["remove"]:
            continue
        if m.get("pair"):
            pairs[spec] = True
            continue
        id3_delete(tags, spec)
        if fld in change["remove"]:
            continue
        value = change["set"][fld]
        if m["kind"] == "performer":
            people = [[role, n] for role, names in value.items() for n in names]
            if people:
                tags.add(TMCL(encoding=3, people=people))
        elif spec.startswith("TXXX:"):
            tags.add(TXXX(encoding=3, desc=spec[5:], text=as_list(m, value)))
        elif spec.startswith("UFID:"):
            tags.add(UFID(owner=spec[5:], data=str(value).encode("ascii")))
        elif spec.startswith("TIPL:"):
            entries = [[spec[5:], n] for n in as_list(m, value)]
            existing = tags.getall("TIPL")
            if existing:
                existing[0].people = list(existing[0].people) + entries
            else:
                tags.add(TIPL(encoding=3, people=entries))
        else:
            tags.add(Frames[spec](encoding=3, text=as_list(m, value)))
    # TRCK/TPOS/MVIN hold "n/total"; recompute from the merged canonical state.
    for spec, (num_f, tot_f) in pair_fields().items():
        if spec not in pairs:
            continue
        n, t = merged(current, change, num_f), merged(current, change, tot_f)
        tags.delall(spec)
        if n is not None:
            tags.add(Frames[spec](encoding=3, text=[f"{n}/{t}" if t is not None else str(n)]))
    if "pictures" in change:
        tags.delall("APIC")
        seen = set()
        for p in change["pictures"]:
            desc = p.get("description") or ""
            # APIC frames are keyed by description; make duplicates unique.
            base, i = desc, 1
            while desc in seen:
                i += 1
                desc = f"{base} ({i})"
            seen.add(desc)
            tags.add(APIC(encoding=3, mime=p["mime"], type=PIC_CODES[p["type"]], desc=desc,
                          data=base64.b64decode(p["data"])))


def merged(current, change, field):
    if field in change["remove"]:
        return None
    if field in change["set"]:
        return change["set"][field]
    return current.get(field)


# ---------------------------------------------------------------- MP4

def mp4_find(tags, atom):
    """Keys matching atom; freeform names match case-insensitively (Picard does too)."""
    if not atom.startswith("----:"):
        return [atom] if atom in tags else []
    a = atom.lower()
    return [k for k in tags.keys() if k.lower() == a]


def mp4_text(v):
    if isinstance(v, (bytes, MP4FreeForm)):
        return bytes(v).decode("utf-8", "replace")
    return str(v)


def mp4_read(f):
    tags = f.tags or {}
    out, pics, raw = {}, [], {}
    for m in MAPPING:
        atom = m["mp4"]
        if atom is None or m["kind"] == "performer":
            continue
        keys = mp4_find(tags, atom)
        if not keys:
            continue
        if m.get("mp4Pair"):
            val = tags[keys[0]][0]
            v = val[m["pair"]["index"]] if len(val) > m["pair"]["index"] else 0
            if v:  # MP4 stores 0 for "unset"
                out[m["field"]] = int(v)
            continue
        vals = [mp4_text(v) for k in keys for v in tags[k]]
        v = shape(m, vals)
        if v is not None:
            out[m["field"]] = v
    for c in tags.get("covr", []):
        mime = "image/png" if c.imageformat == MP4Cover.FORMAT_PNG else "image/jpeg"
        # covr has no picture type; Picard treats embedded MP4 covers as front covers.
        pics.append(out_picture(3, mime, bytes(c), ""))
    for k, vs in tags.items():
        if k == "covr":
            continue
        if k in ("trkn", "disk"):
            raw[k] = [f"{a}/{b}" for a, b in vs]
        else:
            raw[k] = [mp4_text(v) for v in vs] if isinstance(vs, list) else [str(vs)]
    return out, pics, raw


def mp4_write(f, change, current):
    if f.tags is None:
        f.add_tags()
    tags = f.tags
    pairs = set()
    for m in MAPPING:
        fld, atom = m["field"], m["mp4"]
        if atom is None or (fld not in change["set"] and fld not in change["remove"]):
            continue
        if m.get("mp4Pair"):
            pairs.add(atom)
            continue
        for k in mp4_find(tags, atom):
            del tags[k]
        if fld in change["remove"]:
            continue
        vals = as_list(m, change["set"][fld])
        if atom.startswith("----:"):
            # One atom holding every value: duplicate atoms make Navidrome show only one.
            tags[atom] = [MP4FreeForm(v.encode("utf-8")) for v in vals]
        elif m["kind"] == "int":
            # ©mvi, ©mvc, shwm are iTunes integer atoms, not text.
            tags[atom] = [int(change["set"][fld])]
        else:
            tags[atom] = vals
    for atom, (num_f, tot_f) in (("trkn", ("tracknumber", "totaltracks")), ("disk", ("discnumber", "totaldiscs"))):
        if atom not in pairs:
            continue
        n, t = merged(current, change, num_f), merged(current, change, tot_f)
        if atom in tags:
            del tags[atom]
        if n is not None or t is not None:
            tags[atom] = [(int(n or 0), int(t or 0))]
    if "pictures" in change:
        covers = []
        for p in change["pictures"]:
            if p["mime"] not in ("image/jpeg", "image/png"):
                raise UserError(f"MP4 covr supports only JPEG and PNG, got {p['mime']}")
            fmt = MP4Cover.FORMAT_PNG if p["mime"] == "image/png" else MP4Cover.FORMAT_JPEG
            covers.append(MP4Cover(base64.b64decode(p["data"]), fmt))
        if "covr" in tags:
            del tags["covr"]
        if covers:
            tags["covr"] = covers


# ---------------------------------------------------------------- ops

READERS = {"flac": vorbis_read, "ogg": vorbis_read, "opus": vorbis_read, "mp3": id3_read, "m4a": mp4_read}


def op_read(path, picture_data=True):
    global READ_PICTURE_DATA
    READ_PICTURE_DATA = picture_data
    try:
        return _read(path)
    finally:
        READ_PICTURE_DATA = True


def _read(path):
    f, fmt = open_file(path)
    tags, pics, raw = READERS[fmt](f)
    info = f.info
    audio = {"format": fmt, "durationMs": int(round(info.length * 1000))}
    for attr, key in (("sample_rate", "sampleRate"), ("channels", "channels")):
        if getattr(info, attr, None):
            audio[key] = int(getattr(info, attr))
    if getattr(info, "bitrate", None):
        audio["bitrateKbps"] = int(round(info.bitrate / 1000))
    return {"tags": tags, "pictures": pics, "audio": audio, "raw": raw}


def op_write(path, change):
    change.setdefault("set", {})
    change.setdefault("remove", [])
    f, fmt = open_file(path)
    if fmt in ("flac", "ogg", "opus"):
        vorbis_write(f, change)
    elif fmt == "mp3":
        current, _, _ = id3_read(f)
        id3_write(f, change, current)
    else:
        current, _, _ = mp4_read(f)
        mp4_write(f, change, current)
    if FAULT == "crash-mid-write":
        # Test hook: corrupt the (temp) file and die, as a crash would.
        with open(path, "r+b") as fh:
            fh.truncate(max(0, os.path.getsize(path) // 2))
        os._exit(70)
    if fmt == "mp3":
        # v1=1: update an existing ID3v1 tag but never add one.
        f.save(v2_version=4, v1=1)
    else:
        f.save()
    return None


def main():
    global MAPPING
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = {}
        try:
            msg = json.loads(line)
            op = msg.get("op")
            if op == "init":
                MAPPING = msg["mapping"]
                result = {"mutagen": mutagen.version_string}
            elif not MAPPING:
                raise UserError("sidecar not initialised")
            elif op == "read":
                result = op_read(msg["path"], msg.get("pictureData", True) is not False)
            elif op == "write":
                result = op_write(msg["path"], msg["change"])
            else:
                raise UserError(f"unknown op {op!r}")
            resp = {"id": msg.get("id"), "ok": True, "result": result}
        except UserError as e:
            resp = {"id": msg.get("id"), "ok": False, "error": str(e)}
        except Exception as e:  # report, keep serving
            resp = {"id": msg.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}",
                    "trace": traceback.format_exc(limit=3)}
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

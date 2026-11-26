/**
 * File naming templates (docs/proposals/inbox-and-renaming.md, D57). Pure and shared: the server renames
 * with it, and the settings page shows a live example with the same code.
 *
 * `{album} ({date:4})/{disc-}{tracknumber:02} {artist} - {title}`
 *
 * - `{field}`: a canonical tag (§6.2), as it will be after the write; a list is joined with ", ".
 * - `{field:4}`: its first 4 characters. `{field:02}`: a number padded with zeros to 2 digits.
 * - `{a|b}`: the first of the fields that has a value.
 * - `{disc-}`: "2-" (the disc number and a dash) only when the release has more than one disc.
 * - `/` separates folders. A missing value becomes "[unknown <field>]", never an empty name.
 */

export const DEFAULT_TEMPLATE = "{album} ({date:4})/{disc-}{tracknumber:02} {artist} - {title}";

/** The tags a template may use: everything a file name could want, nothing structured (performer). */
export const TEMPLATE_FIELDS = [
  "album",
  "albumartist",
  "albumartistsort",
  "artist",
  "artistsort",
  "artists",
  "title",
  "tracknumber",
  "totaltracks",
  "discnumber",
  "totaldiscs",
  "date",
  "originaldate",
  "label",
  "catalognumber",
  "barcode",
  "media",
  "releasecountry",
  "releasetype",
  "releasestatus",
  "genre",
  "composer",
  "conductor",
  "work",
  "movement",
  "movementnumber",
  "musicbrainz_albumid",
] as const;

const FIELDS = new Set<string>(TEMPLATE_FIELDS);
/** A file system name is at most 255 bytes on every common file system. */
export const MAX_NAME_BYTES = 255;

export type TemplateTags = Partial<Record<string, unknown>>;

interface Token {
  /** Alternatives, the first with a value wins; "disc-" is the disc prefix. */
  names: string[];
  spec: string | null;
}
type Part = string | Token;

/** One template component (between slashes) as literals and tokens; an error message if it does not parse. */
function parseComponent(c: string): Part[] | string {
  const parts: Part[] = [];
  let i = 0;
  while (i < c.length) {
    const open = c.indexOf("{", i);
    const close = c.indexOf("}", i);
    if (close !== -1 && (open === -1 || close < open)) return 'a "}" without its "{"';
    if (open === -1) {
      parts.push(c.slice(i));
      break;
    }
    if (open > i) parts.push(c.slice(i, open));
    const end = c.indexOf("}", open);
    if (end === -1) return 'a "{" without its "}"';
    const body = c.slice(open + 1, end);
    if (body.includes("{")) return 'a "{" inside braces';
    const [names, spec = null] = body.split(":") as [string, string?];
    const alts = names.split("|").map((n) => n.trim());
    if (alts.some((n) => !n)) return `an empty name in {${body}}`;
    for (const n of alts) {
      if (n !== "disc-" && !FIELDS.has(n)) return `unknown field "${n}"`;
    }
    if (spec !== null && !/^\d{1,3}$/.test(spec)) return `"${spec}" in {${body}}: use a number such as 4 or 02`;
    parts.push({ names: alts, spec });
    i = end + 1;
  }
  return parts;
}

/** Why a template cannot be used, or null. */
export function validateTemplate(template: string): string | null {
  const t = template.trim();
  if (!t) return "The template is empty";
  if (t.startsWith("/") || /^[A-Za-z]:/.test(t)) {
    return "The template must be relative to the library, not an absolute path";
  }
  if (t.includes("\\")) return "Use / between folders";
  const components = t.split("/");
  for (const c of components) {
    if (!c.trim()) return "The template has an empty folder name (two slashes, or a slash at the end)";
    if (c.trim() === "." || c.trim() === "..") return '"." and ".." are not allowed';
    const parsed = parseComponent(c);
    if (typeof parsed === "string") return `The template has ${parsed}`;
  }
  const last = components[components.length - 1];
  if (!/\{[^}]*\b(title|tracknumber)\b/.test(last)) {
    return "The file name needs {title} or {tracknumber}, or every track of an album would get the same name";
  }
  return null;
}

/** A value as text: lists joined, numbers as digits; empty when absent. */
function text(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(", ");
  if (typeof v === "object") return "";
  return String(v).trim();
}

function tokenValue(t: Token, tags: TemplateTags): string {
  for (const name of t.names) {
    if (name === "disc-") {
      const total = Number(text(tags.totaldiscs) || 0);
      const disc = text(tags.discnumber);
      // Without a disc total, a disc number above 1 still means several discs.
      if (disc && (total > 1 || Number(disc) > 1)) return `${disc}-`;
      continue;
    }
    let v = text(tags[name]);
    if (!v) continue;
    if (t.spec !== null) {
      const n = Number(t.spec);
      v = t.spec.startsWith("0") ? (/^\d+$/.test(v) ? v.padStart(n, "0") : v) : [...v].slice(0, n).join("");
    }
    return sanitizeName(v);
  }
  const first = t.names[0];
  return first === "disc-" ? "" : `[unknown ${first}]`;
}

/** Characters no common file system (NTFS, SMB, ext4, APFS) takes in a name, and control characters. */
// deno-lint-ignore no-control-regex
const UNSAFE = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;

/** A safe file or folder name: unsafe characters as "_", whitespace collapsed, no trailing dots or spaces. */
export function sanitizeName(s: string): string {
  let n = s.normalize("NFC").replace(UNSAFE, "_").replace(/\s+/g, " ").trim();
  n = n.replace(/[. ]+$/, "");
  if (n.startsWith(".")) n = `_${n.slice(1)}`;
  return n;
}

/** Cut a name to `max` bytes of UTF-8 without splitting a character. */
function truncateBytes(s: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= max) return s;
  let out = "";
  for (const ch of s) {
    if (enc.encode(out + ch).length > max) break;
    out += ch;
  }
  return out.replace(/[. ]+$/, "");
}

/**
 * The relative path a file gets: folders and the file name from the template, then the file's own
 * extension in lower case. Throws on a template that `validateTemplate` refuses.
 */
export function renderPath(template: string, tags: TemplateTags, extension: string): string {
  const error = validateTemplate(template);
  if (error) throw new Error(error);
  const ext = extension.replace(/^\./, "").toLowerCase();
  const components = template.trim().split("/").map((c) => {
    const parts = parseComponent(c) as Part[];
    const name = sanitizeName(parts.map((p) => (typeof p === "string" ? p : tokenValue(p, tags))).join(""));
    return name || "_";
  });
  const last = components.length - 1;
  return components.map((c, i) => {
    if (i < last) return truncateBytes(c, MAX_NAME_BYTES);
    const suffix = ext ? `.${ext}` : "";
    return truncateBytes(c, MAX_NAME_BYTES - new TextEncoder().encode(suffix).length) + suffix;
  }).join("/");
}

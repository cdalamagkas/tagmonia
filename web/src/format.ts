export function duration(ms: number | null): string {
  if (ms === null) return "–";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function when(ms: number | null): string {
  return ms === null ? "–" : new Date(ms).toLocaleString();
}

/** Display form of a canonical tag value. */
export function tagValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.join("; ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, string[]>).map(([role, names]) => `${names.join(", ")} (${role})`).join(
      "; ",
    );
  }
  return String(v);
}

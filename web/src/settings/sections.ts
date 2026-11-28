/** Settings' sections (D75): each has its own address, `/settings/<id>`, and an entry in the side menu. */

export const SETTINGS_SECTIONS = [
  { id: "account", label: "Account" },
  { id: "library", label: "Library & inbox" },
  { id: "files", label: "Files & naming" },
  { id: "tags", label: "Tags & covers" },
  { id: "providers", label: "Providers" },
  { id: "musicbrainz", label: "MusicBrainz" },
] as const;

export type SettingsSection = typeof SETTINGS_SECTIONS[number]["id"];

/** `/settings` opens the first section; an unknown one is null (not found). */
export function settingsSection(rest: string | undefined): SettingsSection | null {
  if (!rest) return "account";
  return SETTINGS_SECTIONS.find((s) => s.id === rest)?.id ?? null;
}

export function settingsLabel(id: SettingsSection): string {
  return SETTINGS_SECTIONS.find((s) => s.id === id)!.label;
}

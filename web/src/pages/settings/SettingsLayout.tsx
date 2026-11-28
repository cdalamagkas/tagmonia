/**
 * Settings (D75): sections, each at `/settings/<section>`, with a side menu; on a phone, a select at the top.
 */
import type { ComponentChildren } from "preact";
import { navigate, onLinkClick } from "../../router.ts";
import { SETTINGS_SECTIONS, settingsLabel, type SettingsSection } from "../../settings/sections.ts";
import { AccountSection } from "./Account.tsx";
import { FilesNamingSection } from "./FilesNaming.tsx";
import { LibraryInboxSection } from "./LibraryInbox.tsx";
import { MusicBrainzSection } from "./MusicBrainz.tsx";
import { ProvidersSection } from "./Providers.tsx";
import { TagsCoversSection } from "./TagsCovers.tsx";

const BODY: Record<SettingsSection, () => ComponentChildren> = {
  account: () => <AccountSection />,
  library: () => <LibraryInboxSection />,
  files: () => <FilesNamingSection />,
  tags: () => <TagsCoversSection />,
  providers: () => <ProvidersSection />,
  musicbrainz: () => <MusicBrainzSection />,
};

export function SettingsPage({ section }: { section: SettingsSection }) {
  return (
    <main class="tm-settings">
      <nav class="tm-settings-menu" aria-label="Settings">
        <p class="tm-settings-heading">Settings</p>
        <ul>
          {SETTINGS_SECTIONS.map((s) => (
            <li key={s.id}>
              <a
                href={`/settings/${s.id}`}
                onClick={onLinkClick}
                aria-current={s.id === section ? "page" : undefined}
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
        <label class="tm-settings-select">
          <span class="tm-visually-hidden">Section</span>
          <select value={section} onChange={(e) => navigate(`/settings/${e.currentTarget.value}`)}>
            {SETTINGS_SECTIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
      </nav>
      <div class="tm-settings-body">
        <h1 class="tm-settings-title">{settingsLabel(section)}</h1>
        {/* A key per section, so each loads its own settings when shown. */}
        <div key={section}>{BODY[section]()}</div>
      </div>
    </main>
  );
}

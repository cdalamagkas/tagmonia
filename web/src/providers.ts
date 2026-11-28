/** The providers page's on/off switch (D67): it shows whether the provider is used, not only the saved choice. */
import type { ProviderDto } from "../../shared/types.ts";

export interface SwitchState {
  checked: boolean;
  disabled: boolean;
  /** Why it is off and cannot be turned on yet, or null. */
  hint: string | null;
}

/**
 * A provider that needs credentials (Discogs, Tidal, Spotify) is not used until they are saved, whatever its
 * switch says, so until then the switch is shown off and cannot be changed. Saved credentials bring back the
 * saved choice (on unless turned off), as setting them is the opt-in.
 */
export function switchState(
  p: Pick<ProviderDto, "enabled" | "configured"> & { fields: { optional: boolean }[] },
): SwitchState | null {
  if (p.enabled === null) return null;
  const needsCredentials = p.fields.some((f) => !f.optional);
  if (needsCredentials && !p.configured) {
    return { checked: false, disabled: true, hint: "Save its credentials first" };
  }
  return { checked: p.enabled, disabled: false, hint: null };
}

export type ProviderStatus = { label: string; tone: "ok" | "error" | "muted" | "info" };

/**
 * One word for the providers list (D75), most telling first: not set up (it cannot be used yet), off (by choice), a
 * check in progress, then the last check's result.
 */
export function providerStatus(
  p: Pick<ProviderDto, "enabled" | "configured" | "health"> & { fields: { optional: boolean }[]; test: unknown },
): ProviderStatus {
  const needsCredentials = p.fields.some((f) => !f.optional);
  if (needsCredentials && !p.configured) return { label: "not set up", tone: "muted" };
  if (p.enabled === false) return { label: "off", tone: "muted" };
  if (p.test) return { label: "checking…", tone: "info" };
  if (!p.health) return { label: "not checked", tone: "muted" };
  return p.health.ok ? { label: "working", tone: "ok" } : { label: "problem", tone: "error" };
}

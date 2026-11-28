/**
 * Settings → Providers (§9.2, §14.3, D46, D75): a compact list by tier, one row per provider with its status and
 * switch; a row opens to its help, credentials (secrets are never shown again once saved) and a health check.
 * `#<provider id>` in the address opens that row.
 */
import { useEffect, useState } from "preact/hooks";
import type { CredentialFieldDto, ProviderDto } from "../../../../shared/types.ts";
import { api } from "../../api.ts";
import { providerStatus, switchState } from "../../providers.ts";
import { when } from "../../format.ts";
import { Note, type NoteValue } from "./Note.tsx";

const TIERS: { tier: ProviderDto["tier"]; label: string; note: string }[] = [
  { tier: "core", label: "Core", note: "Identification." },
  { tier: "enrichment", label: "Enrichment", note: "More details for a release, and links you can paste." },
  { tier: "music_server", label: "Music server", note: "Told about changes after a write or undo." },
];

const TONE: Record<ReturnType<typeof providerStatus>["tone"], string> = {
  ok: "tm-badge-ok",
  error: "tm-badge-error",
  info: "tm-badge-info",
  muted: "",
};

function FieldInput(
  { f, value, onInput }: { f: CredentialFieldDto; value: string; onInput: (v: string) => void },
) {
  if (f.source === "environment") {
    return (
      <p class="tm-muted tm-field-env">
        {f.secret ? "Set" : f.value} — managed by an environment variable, so it can't be changed here.
      </p>
    );
  }
  return (
    <input
      type={f.secret ? "password" : f.kind === "url" ? "url" : "text"}
      autocomplete="off"
      placeholder={f.secret && f.set ? "saved — type to replace" : f.optional ? "optional" : ""}
      value={value}
      onInput={(e) => onInput(e.currentTarget.value)}
    />
  );
}

function ProviderRow(
  { p, open, onToggle, onChanged }: {
    p: ProviderDto;
    open: boolean;
    onToggle: () => void;
    onChanged: () => Promise<void>;
  },
) {
  const editable = p.fields.filter((f) => f.source !== "environment");
  const initial = () => Object.fromEntries(editable.map((f) => [f.key, f.secret ? "" : f.value ?? ""]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<NoteValue>(null);
  useEffect(() => setValues(initial()), [p]);

  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setNote(null);
    try {
      const text = await fn();
      if (text) setNote({ text });
      await onChanged();
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  // Only what the user typed: an empty secret box means "keep the saved one".
  const changed = Object.fromEntries(
    editable
      .filter((f) => (f.secret ? values[f.key] !== "" : values[f.key] !== (f.value ?? "")))
      .map((f) => [f.key, values[f.key] === "" ? null : values[f.key]]),
  );
  const health = p.health;
  const toggle = switchState(p);
  const status = providerStatus(p);
  const detailsId = `provider-${p.id}`;

  return (
    <li class={`tm-provider-row${open ? " tm-open" : ""}`} id={p.id}>
      <div class="tm-provider-head">
        <button
          type="button"
          class="tm-provider-name"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={onToggle}
        >
          <span aria-hidden="true" class="tm-tree-toggle">{open ? "▾" : "▸"}</span>
          {p.name}
        </button>
        <span class={`tm-badge tm-inline ${TONE[status.tone]}`}>{status.label}</span>
        {health && !p.test && <span class="tm-muted tm-small-note tm-provider-when">{when(health.checkedAt)}</span>}
        {toggle && (
          <label class="tm-check tm-provider-switch" title={toggle.hint ?? undefined}>
            <input
              type="checkbox"
              checked={toggle.checked}
              disabled={busy || toggle.disabled}
              onChange={(e) => {
                const enabled = e.currentTarget.checked;
                act(async () => {
                  await api.updateSettings({ providers: { [p.id]: { enabled } } });
                  return null;
                });
              }}
            />
            Use
          </label>
        )}
      </div>
      {!open && note?.error && <Note note={note} />}

      {open && (
        <div class="tm-provider-details" id={detailsId}>
          <p class="tm-muted tm-section-note">{p.help}</p>
          {toggle?.hint && <p class="tm-muted tm-small-note">{toggle.hint}.</p>}
          {p.fields.length > 0 && (
            <form
              class="tm-form tm-cred-form"
              onSubmit={(e) => {
                e.preventDefault();
                act(async () => {
                  const r = await api.saveCredentials(p.id, { values: changed });
                  return r.restartRequired
                    ? `Saved. ${p.name} uses new credentials after Tagmonia restarts.`
                    : "Saved.";
                });
              }}
            >
              {p.fields.map((f) => (
                <label key={f.key}>
                  <span>
                    {f.label}
                    {f.set && f.source === "app" && !f.error && (
                      <span class="tm-badge tm-badge-ok tm-inline">saved</span>
                    )}
                    {f.error && <span class="tm-badge tm-badge-error tm-inline" title={f.error}>unreadable</span>}
                  </span>
                  <FieldInput f={f} value={values[f.key] ?? ""} onInput={(v) => setValues({ ...values, [f.key]: v })} />
                  {f.error && <span class="tm-error">{f.error}</span>}
                </label>
              ))}
              {editable.length > 0 && (
                <div class="tm-actions">
                  <button type="submit" class="tm-button" disabled={busy || Object.keys(changed).length === 0}>
                    Save
                  </button>
                  {editable.some((f) => f.set) && (
                    <button
                      type="button"
                      class="tm-button tm-secondary"
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          await api.saveCredentials(p.id, {
                            values: Object.fromEntries(editable.filter((f) => f.set).map((f) => [f.key, null])),
                          });
                          return "Removed.";
                        })}
                    >
                      Remove saved values
                    </button>
                  )}
                </div>
              )}
            </form>
          )}
          <p class="tm-provider-health">
            {p.test ? <span class="tm-muted">Checking…</span> : health
              ? (
                <span>
                  {health.message} <span class="tm-muted">({when(health.checkedAt)})</span>
                </span>
              )
              : <span class="tm-muted">{p.configured ? "Not checked yet." : "Not set up."}</span>}{" "}
            <button
              type="button"
              class="tm-button tm-secondary tm-small"
              disabled={busy || !!p.test}
              onClick={() =>
                act(async () => {
                  await api.testProvider(p.id);
                  return null;
                })}
            >
              Test
            </button>
          </p>
          <Note note={note} />
        </div>
      )}
    </li>
  );
}

export function ProvidersSection() {
  const [providers, setProviders] = useState<ProviderDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set(location.hash ? [location.hash.slice(1)] : []));
  const load = async () => {
    try {
      setProviders((await api.providers()).providers);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  // Poll while a health check runs.
  useEffect(() => {
    if (!providers?.some((p) => p.test)) return;
    const t = setTimeout(load, 1500);
    return () => clearTimeout(t);
  }, [providers]);
  // A link to one provider (`#youtube`): show it once the list is there.
  useEffect(() => {
    if (providers && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [!!providers]);

  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <>
      <p class="tm-muted tm-section-note">
        Where Tagmonia looks up music, and the music server it tells about changes. Secrets are stored encrypted and
        never shown again once saved; values set through environment variables take precedence.
      </p>
      {error && <p class="tm-error" role="alert">{error}</p>}
      {providers && TIERS.map(({ tier, label, note }) => {
        const list = providers.filter((p) => p.tier === tier);
        if (list.length === 0) return null;
        return (
          <section class="tm-card" key={tier}>
            <h2>{label}</h2>
            <p class="tm-muted tm-small-note">{note}</p>
            <ul class="tm-provider-list">
              {list.map((p) => (
                <ProviderRow
                  key={p.id}
                  p={p}
                  open={open.has(p.id)}
                  onToggle={() => toggle(p.id)}
                  onChanged={load}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

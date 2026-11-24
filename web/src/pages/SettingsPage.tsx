/**
 * Settings → Providers (§9.2, §14.3, D46): credentials (secrets are never shown
 * again once saved), on/off switches and a health check per provider.
 */
import { useEffect, useState } from "preact/hooks";
import type { CredentialFieldDto, ProviderDto } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { when } from "../format.ts";

const TIER: Record<ProviderDto["tier"], string> = {
  core: "core",
  enrichment: "enrichment",
  music_server: "music server",
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

function ProviderCard({ p, onChanged }: { p: ProviderDto; onChanged: () => Promise<void> }) {
  const editable = p.fields.filter((f) => f.source !== "environment");
  const initial = () => Object.fromEntries(editable.map((f) => [f.key, f.secret ? "" : f.value ?? ""]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  useEffect(() => setValues(initial()), [p]);

  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setNote(null);
    try {
      const text = await fn();
      if (text) setNote({ error: false, text });
      await onChanged();
    } catch (e) {
      setNote({ error: true, text: (e as Error).message });
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

  return (
    <section class="tm-card tm-provider">
      <div class="tm-toolbar">
        <div>
          <h2>
            {p.name} <span class="tm-badge tm-inline">{TIER[p.tier]}</span>
          </h2>
          <p class="tm-muted tm-section-note">{p.help}</p>
        </div>
        {p.enabled !== null && (
          <label class="tm-check">
            <input
              type="checkbox"
              checked={p.enabled}
              disabled={busy}
              onChange={(e) => {
                const enabled = e.currentTarget.checked;
                act(async () => {
                  await api.updateSettings({ providers: { [p.id]: { enabled } } });
                  return null;
                });
              }}
            />
            Use {p.name}
          </label>
        )}
      </div>

      {p.fields.length > 0 && (
        <form
          class="tm-form tm-cred-form"
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              const r = await api.saveCredentials(p.id, { values: changed });
              return r.restartRequired ? `Saved. ${p.name} uses new credentials after Tagmonia restarts.` : "Saved.";
            });
          }}
        >
          {p.fields.map((f) => (
            <label key={f.key}>
              <span>
                {f.label}
                {f.set && f.source === "app" && !f.error && <span class="tm-badge tm-badge-ok tm-inline">saved</span>}
                {f.error && <span class="tm-badge tm-badge-error tm-inline" title={f.error}>unreadable</span>}
              </span>
              <FieldInput f={f} value={values[f.key] ?? ""} onInput={(v) => setValues({ ...values, [f.key]: v })} />
              {f.error && <span class="tm-error">{f.error}</span>}
            </label>
          ))}
          {editable.length > 0 && (
            <div class="tm-actions">
              <button type="submit" class="tm-button" disabled={busy || Object.keys(changed).length === 0}>Save</button>
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
              <span class={`tm-badge tm-inline ${health.ok ? "tm-badge-ok" : "tm-badge-error"}`}>
                {health.ok ? "working" : "problem"}
              </span>{" "}
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
      {note && <p class={note.error ? "tm-error" : "tm-muted"} role={note.error ? "alert" : undefined}>{note.text}</p>}
    </section>
  );
}

export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <main>
      <section class="tm-card">
        <h1>Providers</h1>
        <p class="tm-muted tm-section-note">
          Where Tagmonia looks up music, and the music server it tells about changes. Secrets are stored encrypted and
          never shown again once saved; values set through environment variables take precedence.
        </p>
      </section>
      {error && <p class="tm-error" role="alert">{error}</p>}
      {providers?.map((p) => <ProviderCard key={p.id} p={p} onChanged={load} />)}
    </main>
  );
}

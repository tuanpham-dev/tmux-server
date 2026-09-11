import { useEffect, useRef, useState } from "react";
import { getAiCliStatus, getAiKeyStatus, setAiKey, type AiKeyStatus } from "../../api";
import type { AiProfile, AiProviderId, AppSettings } from "../../settings";
import Icon from "../Icon";
import AiModelField from "./AiModelField";
import { useSettingsContext } from "./context";

// Settings → AI Providers. One place answers "which AI do I have?", for the app and
// every extension that asks for one (plans/core-ai-providers.md) — the
// commit-message button in SOURCE CONTROL, AI Command Search, and the prompt
// editor's Refine all run through what is configured here.
//
// Several can be configured at once: a CLI you're already signed into for
// the everyday jobs, a keyed API for the ones worth paying for. One is the
// default (what a caller that doesn't care gets), and an extension can point
// its own feature at any of the others through an "ai-profile" setting of
// its own — see ExtensionConfigSection's picker.

const PROVIDERS: { id: AiProviderId; label: string; hint: string }[] = [
  { id: "claude", label: "Claude Code (claude CLI)", hint: "Uses your existing Claude Code sign-in - no API key needed." },
  { id: "codex", label: "OpenAI Codex (codex CLI)", hint: "Uses your existing Codex sign-in - no API key needed." },
  { id: "agy", label: "Antigravity (agy CLI)", hint: "Uses your existing Antigravity sign-in - no API key needed." },
  { id: "anthropic", label: "Anthropic API (key)", hint: "Anthropic's Messages format - to Anthropic, or to any compatible endpoint you set below. Defaults to claude-opus-5 when no model is set." },
  { id: "openai", label: "OpenAI API (key)", hint: "OpenAI's chat-completions format - to OpenAI, or to any compatible endpoint you set below. A model is required." },
  { id: "custom", label: "Custom command", hint: "Any command that takes the prompt as its last argument and prints the reply." },
];

const CLI_PROVIDERS: AiProviderId[] = ["claude", "codex", "agy"];
const KEYED_PROVIDERS: AiProviderId[] = ["anthropic", "openai"];

// The id the server synthesizes for the pre-profiles settings keys (ai.ts's
// LEGACY_PROFILE_ID). Reused when seeding the list from them, so a key
// already stored under a provider name keeps resolving and a caller that
// stored "default" still points at the same AI.
const LEGACY_PROFILE_ID = "default";

function providerLabel(id: AiProviderId): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

// Provider options, with the CLIs that aren't installed on the server greyed
// out — picking one could only ever fail on the first call. `selected` is
// never disabled: a profile already pointing at a CLI you've since removed
// still has to render (and stay selectable) rather than silently switching
// to something else.
function providerOptions(cliStatus: Record<string, boolean> | null, selected?: AiProviderId) {
  return PROVIDERS.map((p) => {
    const missing = !!cliStatus && CLI_PROVIDERS.includes(p.id) && !cliStatus[p.id];
    const disabled = missing && p.id !== selected;
    return (
      <option key={p.id} value={p.id} disabled={disabled}>
        {p.label}
        {missing ? " - not installed" : ""}
      </option>
    );
  });
}

// Short and readable rather than random: "openai", "openai-2", … Ids are
// stored by extensions and used as the API key's storage key, so they must
// be stable, unique, and safe as a plain object key.
function makeProfileId(provider: AiProviderId, taken: readonly string[]): string {
  if (!taken.includes(provider)) return provider;
  for (let n = 2; ; n++) {
    const candidate = `${provider}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

// What the pre-profiles keys describe, as the list's first entry. Every
// field carries over, so nothing has to be retyped — including the API key,
// which the server still finds under its provider name (see ai.ts's
// resolveKey).
function seedFromLegacy(settings: AppSettings): AiProfile {
  return {
    id: LEGACY_PROFILE_ID,
    label: providerLabel(settings.aiProvider),
    provider: settings.aiProvider,
    model: settings.aiModel,
    binaryPath: settings.aiBinaryPath,
    customCommand: settings.aiCustomCommand,
    baseUrl: settings.aiBaseUrl,
    enabled: true,
  };
}

// The key never comes back from the server, so the field is a write-only box
// over a boolean: it shows whether one is stored, and typing replaces it.
function ApiKeyField({
  profile,
  stored,
  optional,
  onChanged,
}: {
  profile: AiProfile;
  stored: boolean;
  // A custom endpoint may need no auth at all (a local Ollama), so the field
  // says so rather than implying the call will fail without one.
  optional: boolean;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (key: string) => {
    setBusy(true);
    setError(null);
    try {
      await setAiKey(profile.id, key);
      setDraft("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-row">
      <span className="settings-label">
        API key{" "}
        <span className="settings-hint">
          - {stored ? "stored" : optional ? "not set (optional for this endpoint)" : "not set"}
        </span>
      </span>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="dialog-input"
          style={{ flex: 1 }}
          type="password"
          autoComplete="off"
          placeholder={stored ? "Stored - type to replace" : `Paste your ${profile.provider} API key`}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) void save(draft);
          }}
        />
        <button className="dialog-button primary" disabled={busy || !draft.trim()} onClick={() => void save(draft)}>
          Save
        </button>
        {stored && (
          <button className="dialog-button secondary" disabled={busy} onClick={() => void save("")}>
            Clear
          </button>
        )}
      </div>
      {error && <div className="settings-hint settings-error">{error}</div>}
    </div>
  );
}

// One profile's own fields, shown while it's expanded.
function ProfileEditor({
  profile,
  keys,
  cliStatus,
  onChange,
  onKeysChanged,
}: {
  profile: AiProfile;
  keys: AiKeyStatus | null;
  cliStatus: Record<string, boolean> | null;
  onChange: (next: AiProfile) => void;
  onKeysChanged: () => void;
}) {
  const hint = PROVIDERS.find((p) => p.id === profile.provider)?.hint;
  const isCli = CLI_PROVIDERS.includes(profile.provider);
  // A binary path is the escape hatch for a CLI that isn't on the server's
  // PATH (a version manager's shim, a checkout), so it silences the warning.
  const cliMissing = isCli && !!cliStatus && !cliStatus[profile.provider] && !profile.binaryPath.trim();
  const keyed = KEYED_PROVIDERS.includes(profile.provider);
  // Either storage key counts as configured: a profile seeded from the
  // pre-profiles settings has its key under the provider name.
  const storedKey = !!(keys?.has?.[profile.id] ?? keys?.has?.[profile.provider]);

  return (
    <div className="ai-profile-editor">
      <div className="settings-row">
        <span className="settings-label">Name</span>
        <input
          className="dialog-input"
          value={profile.label}
          placeholder={providerLabel(profile.provider)}
          onChange={(e) => onChange({ ...profile, label: e.target.value })}
        />
        <div className="settings-hint">What pickers call this one - yours to name.</div>
      </div>

      <div className="settings-row">
        <span className="settings-label">Provider</span>
        <select
          className="dialog-input settings-select"
          value={profile.provider}
          onChange={(e) => onChange({ ...profile, provider: e.target.value as AiProviderId })}
        >
          {providerOptions(cliStatus, profile.provider)}
        </select>
        {cliMissing ? (
          <div className="settings-hint settings-error">
            No <code>{profile.provider}</code> on the server&apos;s PATH - install it, or give this
            profile a binary path below.
          </div>
        ) : (
          hint && <div className="settings-hint">{hint}</div>
        )}
      </div>

      {keyed && (
        <div className="settings-row">
          <span className="settings-label">Endpoint</span>
          <input
            className="dialog-input"
            placeholder={
              profile.provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com/v1"
            }
            value={profile.baseUrl}
            onChange={(e) => onChange({ ...profile, baseUrl: e.target.value })}
          />
          <div className="settings-hint">
            Leave empty for {profile.provider === "openai" ? "OpenAI" : "Anthropic"} itself. Set it to
            send the same request format to any compatible service - OpenRouter, Groq, Together,
            LiteLLM, or a local Ollama - including the version segment, e.g.{" "}
            <code>https://openrouter.ai/api/v1</code>.
          </div>
        </div>
      )}

      {keyed && (
        <ApiKeyField
          profile={profile}
          stored={storedKey}
          optional={!!profile.baseUrl.trim()}
          onChanged={onKeysChanged}
        />
      )}

      <div className="settings-row">
        <span className="settings-label">Model</span>
        <AiModelField
          id={profile.id}
          value={profile.model}
          profileId={profile.id}
          // Every provider but "custom" can be asked for a list — the API
          // ones over HTTP, the CLIs by running them (see ai.ts's
          // listCliModels). A command line the user wrote has no answer.
          fetchable={profile.provider !== "custom"}
          placeholder={
            profile.provider === "openai"
              ? "Required for the OpenAI API, e.g. gpt-4.1-mini"
              : profile.provider === "anthropic"
                ? "claude-opus-5"
                : "Leave empty for the CLI's own default"
          }
          hint="A smaller, faster model is usually the better choice for short jobs like writing a commit message."
          onChange={(model) => onChange({ ...profile, model })}
        />
      </div>

      {isCli && (
        <div className="settings-row">
          <span className="settings-label">Binary path</span>
          <input
            className="dialog-input"
            placeholder={`Leave empty to use "${profile.provider}" from PATH`}
            value={profile.binaryPath}
            onChange={(e) => onChange({ ...profile, binaryPath: e.target.value })}
          />
        </div>
      )}

      {profile.provider === "custom" && (
        <div className="settings-row">
          <span className="settings-label">Command</span>
          <input
            className="dialog-input"
            placeholder="my-llm --quiet"
            value={profile.customCommand}
            onChange={(e) => onChange({ ...profile, customCommand: e.target.value })}
          />
          <div className="settings-hint">
            Run as <code>sh -c &apos;&lt;command&gt; &quot;$0&quot;&apos;</code> with the prompt as the
            single trailing argument, so your own quoting is preserved.
          </div>
        </div>
      )}
    </div>
  );
}

export default function AiSection() {
  const { settings, onSettingsChange } = useSettingsContext();
  // One write per change, however many keys it touches. The context's own
  // `set` rebuilds from the `settings` of the render it was called in, so
  // two calls in a row (list + default) would have the second overwrite the
  // first — caught in QA, where seeding wrote the profile list and then
  // immediately dropped it again.
  const patch = (next: Partial<AppSettings>) => onSettingsChange({ ...settings, ...next });
  const [keys, setKeys] = useState<AiKeyStatus | null>(null);
  // null until the probe answers — everything renders as available until
  // then rather than flashing every CLI as missing.
  const [cliStatus, setCliStatus] = useState<Record<string, boolean> | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addProvider, setAddProvider] = useState<AiProviderId>("anthropic");

  const refreshKeys = () => {
    getAiKeyStatus()
      .then(setKeys)
      .catch(() => setKeys(null));
  };
  useEffect(refreshKeys, []);
  useEffect(() => {
    getAiCliStatus()
      .then(setCliStatus)
      .catch(() => setCliStatus(null));
  }, []);

  const profiles = settings.aiProfiles;

  // First open after upgrading: show the single AI that was already
  // configured as the list's first entry, so nothing looks lost and nothing
  // has to be retyped. Runs once — a user who deliberately deletes every
  // profile is not re-seeded.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || profiles.length > 0) return;
    seededRef.current = true;
    patch({
      aiProfiles: [seedFromLegacy(settings)],
      aiProfileId: settings.aiProfileId || LEGACY_PROFILE_ID,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles.length]);

  const enabled = profiles.filter((p) => p.enabled);
  // Mirrors ai.ts's own fallback, so the "Default" marker names the profile
  // that would actually answer.
  const defaultId = enabled.find((p) => p.id === settings.aiProfileId)?.id ?? enabled[0]?.id ?? "";

  const update = (id: string, next: AiProfile) =>
    patch({ aiProfiles: profiles.map((p) => (p.id === id ? next : p)) });

  const add = () => {
    const id = makeProfileId(addProvider, profiles.map((p) => p.id));
    patch({
      aiProfiles: [
        ...profiles,
        {
          id,
          label: providerLabel(addProvider),
          provider: addProvider,
          model: "",
          binaryPath: "",
          customCommand: "",
          baseUrl: "",
          enabled: true,
        },
      ],
    });
    setExpandedId(id);
  };

  const remove = (id: string) => {
    patch({
      aiProfiles: profiles.filter((p) => p.id !== id),
      ...(settings.aiProfileId === id ? { aiProfileId: "" } : {}),
    });
    if (expandedId === id) setExpandedId(null);
    // The stored key is deliberately left alone: removing a profile by
    // accident shouldn't cost a key that can't be read back to restore.
  };

  return (
    <>
      <div className="settings-row">
        <span className="settings-label">Configured AIs</span>
        <div className="settings-hint">
          Add as many as you like. The one marked default answers anything that doesn&apos;t ask for a
          particular AI; an extension with its own AI setting can point at any of the others.
        </div>
      </div>

      <div className="ai-profile-list">
        {profiles.map((profile) => {
          const isExpanded = expandedId === profile.id;
          return (
            <div key={profile.id} className={`ai-profile${isExpanded ? " expanded" : ""}`}>
              <div className="ai-profile-head">
                <input
                  type="checkbox"
                  checked={profile.enabled}
                  title={profile.enabled ? "Enabled - uncheck to keep it but stop offering it" : "Disabled"}
                  onChange={(e) => update(profile.id, { ...profile, enabled: e.target.checked })}
                />
                <button
                  className="ai-profile-name"
                  onClick={() => setExpandedId(isExpanded ? null : profile.id)}
                  aria-expanded={isExpanded}
                >
                  <Icon name={isExpanded ? "chevron-down" : "chevron-right"} />
                  <span>{profile.label || providerLabel(profile.provider)}</span>
                  <span className="settings-hint">
                    {providerLabel(profile.provider)}
                    {profile.model ? ` · ${profile.model}` : ""}
                  </span>
                </button>
                <label className="ai-profile-default" title="Use this one when nothing asks for a particular AI">
                  <input
                    type="radio"
                    name="ai-default-profile"
                    checked={defaultId === profile.id}
                    disabled={!profile.enabled}
                    onChange={() => patch({ aiProfileId: profile.id })}
                  />
                  <span>Default</span>
                </label>
                <button className="icon-button" title="Remove" onClick={() => remove(profile.id)}>
                  <Icon name="trash" />
                </button>
              </div>
              {isExpanded && (
                <ProfileEditor
                  profile={profile}
                  keys={keys}
                  cliStatus={cliStatus}
                  onChange={(next) => update(profile.id, next)}
                  onKeysChanged={refreshKeys}
                />
              )}
            </div>
          );
        })}
        {profiles.length === 0 && <div className="settings-hint">No AI configured yet.</div>}
      </div>

      <div className="settings-row">
        <span className="settings-label">Add</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            className="dialog-input settings-select"
            style={{ flex: 1 }}
            value={addProvider}
            onChange={(e) => setAddProvider(e.target.value as AiProviderId)}
          >
            {providerOptions(cliStatus)}
          </select>
          <button className="dialog-button primary" onClick={add}>
            Add
          </button>
        </div>
      </div>
    </>
  );
}

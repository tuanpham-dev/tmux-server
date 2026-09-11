import { useEffect, useState } from "react";
import { getAiKeyStatus, setAiKey, type AiKeyStatus } from "../../api";
import type { AppSettings } from "../../settings";
import { useSettingsContext } from "./context";

// Settings → AI. One place answers "which AI do I have?", for the app and
// every extension that asks for one (plans/core-ai-providers.md) — the
// commit-message button in SOURCE CONTROL, AI Command Search, and the prompt
// editor's Refine all run through whatever is chosen here.

type Provider = AppSettings["aiProvider"];

const PROVIDERS: { id: Provider; label: string; hint: string }[] = [
  { id: "claude", label: "Claude Code (claude CLI)", hint: "Uses your existing Claude Code sign-in — no API key needed." },
  { id: "codex", label: "OpenAI Codex (codex CLI)", hint: "Uses your existing Codex sign-in — no API key needed." },
  { id: "agy", label: "Antigravity (agy CLI)", hint: "Uses your existing Antigravity sign-in — no API key needed." },
  { id: "anthropic", label: "Anthropic API (key)", hint: "Anthropic's Messages format — to Anthropic, or to any compatible endpoint you set below. Defaults to claude-opus-5 when no model is set." },
  { id: "openai", label: "OpenAI API (key)", hint: "OpenAI's chat-completions format — to OpenAI, or to any compatible endpoint you set below. A model is required." },
  { id: "custom", label: "Custom command", hint: "Any command that takes the prompt as its last argument and prints the reply." },
];

const CLI_PROVIDERS: Provider[] = ["claude", "codex", "agy"];
const KEYED_PROVIDERS = ["anthropic", "openai"] as const;

// The key never comes back from the server, so the field is a write-only box
// over a boolean: it shows whether one is stored, and typing replaces it.
function ApiKeyField({
  provider,
  stored,
  optional,
  onChanged,
}: {
  provider: (typeof KEYED_PROVIDERS)[number];
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
      await setAiKey(provider, key);
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
          — {stored ? "stored" : optional ? "not set (optional for this endpoint)" : "not set"}
        </span>
      </span>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="dialog-input"
          style={{ flex: 1 }}
          type="password"
          autoComplete="off"
          placeholder={stored ? "Stored — type to replace" : `Paste your ${provider} API key`}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) void save(draft);
          }}
        />
        <button className="dialog-button" disabled={busy || !draft.trim()} onClick={() => void save(draft)}>
          Save
        </button>
        {stored && (
          <button className="dialog-button secondary" disabled={busy} onClick={() => void save("")}>
            Clear
          </button>
        )}
      </div>
      <div className="settings-hint">
        Kept on the server and never sent back to a browser — this box can set it, not read it.
      </div>
      {error && <div className="settings-hint">{error}</div>}
    </div>
  );
}

export default function AiSection() {
  const { settings, set } = useSettingsContext();
  const [keys, setKeys] = useState<AiKeyStatus | null>(null);

  const refreshKeys = () => {
    getAiKeyStatus()
      .then(setKeys)
      .catch(() => setKeys(null));
  };
  useEffect(refreshKeys, []);

  const provider = settings.aiProvider;
  const active = PROVIDERS.find((p) => p.id === provider);
  const isCli = CLI_PROVIDERS.includes(provider);
  const keyed = KEYED_PROVIDERS.find((p) => p === provider);

  return (
    <>
      <div className="settings-row">
        <span className="settings-label">Provider</span>
        <select
          className="dialog-input"
          value={provider}
          onChange={(e) => set("aiProvider", e.target.value as Provider)}
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {active && <div className="settings-hint">{active.hint}</div>}
      </div>

      {keyed && (
        <div className="settings-row">
          <span className="settings-label">Endpoint</span>
          <input
            className="dialog-input"
            placeholder={keyed === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com/v1"}
            value={settings.aiBaseUrl}
            onChange={(e) => set("aiBaseUrl", e.target.value)}
          />
          <div className="settings-hint">
            Leave empty for {keyed === "openai" ? "OpenAI" : "Anthropic"} itself. Set it to send the
            same request format to any compatible service — OpenRouter, Groq, Together, LiteLLM, or a
            local Ollama — including the version segment, e.g.{" "}
            <code>https://openrouter.ai/api/v1</code>.
          </div>
        </div>
      )}

      {keyed && (
        <ApiKeyField
          provider={keyed}
          stored={!!keys?.[keyed]}
          optional={!!settings.aiBaseUrl.trim()}
          onChanged={refreshKeys}
        />
      )}

      <div className="settings-row">
        <span className="settings-label">Model</span>
        <input
          className="dialog-input"
          placeholder={
            provider === "openai"
              ? "Required for the OpenAI API, e.g. gpt-4.1-mini"
              : provider === "anthropic"
                ? "claude-opus-5"
                : "Leave empty for the CLI's own default"
          }
          value={settings.aiModel}
          onChange={(e) => set("aiModel", e.target.value)}
        />
        <div className="settings-hint">
          A smaller, faster model is usually the better choice for short jobs like writing a commit
          message.
        </div>
      </div>

      {isCli && (
        <div className="settings-row">
          <span className="settings-label">Binary path</span>
          <input
            className="dialog-input"
            placeholder={`Leave empty to use "${provider}" from PATH`}
            value={settings.aiBinaryPath}
            onChange={(e) => set("aiBinaryPath", e.target.value)}
          />
        </div>
      )}

      {provider === "custom" && (
        <div className="settings-row">
          <span className="settings-label">Command</span>
          <input
            className="dialog-input"
            placeholder="my-llm --quiet"
            value={settings.aiCustomCommand}
            onChange={(e) => set("aiCustomCommand", e.target.value)}
          />
          <div className="settings-hint">
            Run as <code>sh -c &apos;&lt;command&gt; &quot;$0&quot;&apos;</code> with the prompt as the
            single trailing argument, so your own quoting is preserved.
          </div>
        </div>
      )}
    </>
  );
}

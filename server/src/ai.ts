// The app's one AI backend. Everything that turns a prompt into text — the
// git-scm commit-message button, ai-command, prompts — comes through runAi,
// so "which AI do I have?" is answered once, in Settings → AI, instead of
// once per extension (plans/core-ai-providers.md).
//
// Two provider families:
//   CLI    claude / codex / agy / custom — a locally installed binary, run
//          one-shot ("print the reply and exit"); no key, no interactive or
//          agent mode, and nothing here executes any part of the reply.
//   API    anthropic / openai — a single HTTPS POST with a key read from the
//          settings store's server-only aiSecrets (see settingsStore.ts).
//          Hand-rolled fetch rather than an SDK: one short call each, and the
//          server takes no new dependency for it. The provider picks the WIRE
//          FORMAT, not the vendor: aiBaseUrl points either format at any
//          compatible endpoint (OpenRouter, Groq, Together, LiteLLM, a local
//          Ollama), which is why there is no separate provider per vendor.
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { readAiSecrets, readSettingsDoc } from "./settingsStore.js";

const TIMEOUT_MS = 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;
// Long enough for a commit message or a refined prompt; this is a one-shot
// text call, not a conversation.
const MAX_OUTPUT_TOKENS = 4096;
// Documented default for the Anthropic API. OpenAI gets no baked-in default
// — see AiError("missing-model").
const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5";
// Official endpoints, used when aiBaseUrl is empty. Both include the version
// segment, so a third-party base URL is given the same way the vendors
// document theirs (".../v1") and the route below is appended to it.
const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com/v1";
// Required on every Anthropic API call, the models list included.
const ANTHROPIC_VERSION = "2023-06-01";
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

export type AiErrorCode =
  | "unsupported"
  | "missing-binary"
  | "missing-key"
  | "missing-model"
  | "missing-command"
  | "provider-failed"
  | "empty-reply";

// Typed so a caller can tell "you haven't configured this yet" from "the
// provider broke", and surface the first as guidance rather than an error.
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

// One configured AI, as Settings → AI lists them. Several can be set up at
// once — a CLI you're signed into, a keyed API for the jobs worth paying
// for — and each caller (core, or any extension) either names one or gets
// the default.
export interface AiProfile {
  // Stable across renames: what a caller stores when it picks a profile.
  id: string;
  label: string;
  provider: string;
  model: string;
  binaryPath: string;
  customCommand: string;
  baseUrl: string;
  enabled: boolean;
}

// The id of the profile synthesized from the pre-profiles settings keys
// (aiProvider/aiModel/…). Stable, so a caller that stored it before the
// user ever opened Settings → AI keeps resolving to the same AI once the
// UI writes the real list.
const LEGACY_PROFILE_ID = "default";

function readString(source: Record<string, unknown>, key: string): string {
  return typeof source[key] === "string" ? (source[key] as string).trim() : "";
}

// The pre-profiles settings keys, as one profile. Also the fallback for a
// settings document whose profile list is empty or unparseable — there is
// always at least one profile, so runAi never has nothing to run.
function legacyProfile(settings: Record<string, unknown>): AiProfile {
  return {
    id: LEGACY_PROFILE_ID,
    label: "Default",
    provider: readString(settings, "aiProvider") || "claude",
    model: readString(settings, "aiModel"),
    binaryPath: readString(settings, "aiBinaryPath"),
    customCommand: readString(settings, "aiCustomCommand"),
    baseUrl: readString(settings, "aiBaseUrl"),
    enabled: true,
  };
}

function parseProfile(raw: unknown): AiProfile | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const id = readString(source, "id");
  const provider = readString(source, "provider");
  if (!id || !provider) return null;
  return {
    id,
    label: readString(source, "label") || provider,
    provider,
    model: readString(source, "model"),
    binaryPath: readString(source, "binaryPath"),
    customCommand: readString(source, "customCommand"),
    baseUrl: readString(source, "baseUrl"),
    // Absent means enabled: a profile is only ever written by the settings
    // UI, and a hand-edited entry that forgot the flag means "use it".
    enabled: source.enabled !== false,
  };
}

interface AiConfigDoc {
  profiles: AiProfile[];
  defaultProfileId: string;
}

async function readAiConfig(): Promise<AiConfigDoc> {
  const doc = await readSettingsDoc();
  const settings = (doc.settings ?? {}) as Record<string, unknown>;
  const raw = settings.aiProfiles;
  const parsed = Array.isArray(raw) ? raw.map(parseProfile).filter((p): p is AiProfile => p !== null) : [];
  return {
    profiles: parsed.length > 0 ? parsed : [legacyProfile(settings)],
    defaultProfileId: readString(settings, "aiProfileId"),
  };
}

// What a caller may choose between: the enabled profiles, in the user's own
// order, with the default first-class so a picker can mark it. Never
// includes a binary path, a base URL or anything else an extension has no
// business seeing — only what it takes to name one.
export interface AiProfileSummary {
  id: string;
  label: string;
  provider: string;
  model: string;
  isDefault: boolean;
}

export async function listAiProfiles(): Promise<AiProfileSummary[]> {
  const { profiles, defaultProfileId } = await readAiConfig();
  const enabled = profiles.filter((p) => p.enabled);
  const fallbackId = enabled.find((p) => p.id === defaultProfileId)?.id ?? enabled[0]?.id ?? "";
  return enabled.map((p) => ({
    id: p.id,
    label: p.label,
    provider: p.provider,
    model: p.model,
    isDefault: p.id === fallbackId,
  }));
}

// Explicitly named profile, else the configured default, else the first
// enabled one, else the first one at all. A caller that names a profile the
// user has since deleted or disabled falls back rather than failing: its
// stored id is a preference, not a dependency.
async function resolveProfile(profileId?: string): Promise<AiProfile> {
  const { profiles, defaultProfileId } = await readAiConfig();
  const wanted = profileId?.trim();
  const named = wanted ? profiles.find((p) => p.id === wanted && p.enabled) : undefined;
  return (
    named ??
    profiles.find((p) => p.id === defaultProfileId && p.enabled) ??
    profiles.find((p) => p.enabled) ??
    profiles[0]
  );
}

// `${base}/${route}` with any trailing slash on the base collapsed, so both
// "https://host/v1" and "https://host/v1/" resolve the same way.
function endpoint(base: string, fallback: string, route: string): string {
  const root = (base || fallback).replace(/\/+$/, "");
  return `${root}/${route}`;
}

// Each entry is a one-shot invocation. `agy` takes --model (not -m) like
// claude, and its plain-text print mode returns cleanly from a non-TTY
// subprocess on 1.2.0 — verified before this shipped, so no --output-format
// json parsing is needed (antigravity-cli#76 was 1.0.0/Windows).
const CLI_PROVIDERS: Record<string, { bin: string; args: (prompt: string, model: string) => string[] }> = {
  claude: { bin: "claude", args: (prompt, model) => ["-p", ...(model ? ["--model", model] : []), prompt] },
  codex: { bin: "codex", args: (prompt, model) => ["exec", ...(model ? ["-m", model] : []), prompt] },
  agy: { bin: "agy", args: (prompt, model) => ["-p", ...(model ? ["--model", model] : []), prompt] },
};

// ---- CLI availability ----
// Which of the CLI providers are actually installed, so Settings → AI can
// grey out a provider that would only ever fail with "claude CLI not found"
// the first time something asked it for text.
//
// A PATH walk rather than `which`/`command -v`: no subprocess per provider
// (this is polled by a settings dialog, not a one-shot), and no dependency
// on a lookup tool being present on a minimal box. A provider with an
// explicit binary path configured is NOT covered — that path is the user's
// own claim, checked when the call runs.

const CLI_PROBE_TTL_MS = 15_000;
let cliProbe: { at: number; value: Record<string, boolean> } | null = null;

async function isOnPath(bin: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      await access(path.join(dir, bin), constants.X_OK);
      return true;
    } catch {
      // Not here (or not executable) — keep looking.
    }
  }
  return false;
}

// provider id → installed. Cached briefly: a settings dialog re-reads this
// on every open, and installing a CLI mid-dialog is not a case worth a
// filesystem walk per keystroke for.
export async function probeCliProviders(): Promise<Record<string, boolean>> {
  if (cliProbe && Date.now() - cliProbe.at < CLI_PROBE_TTL_MS) return cliProbe.value;
  const value: Record<string, boolean> = {};
  await Promise.all(
    Object.entries(CLI_PROVIDERS).map(async ([provider, { bin }]) => {
      value[provider] = await isOnPath(bin);
    }),
  );
  cliProbe = { at: Date.now(), value };
  return value;
}

function runCli(bin: string, args: string[], provider: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, cwd },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || "").trim().slice(0, 300);
          if (/ENOENT/.test(err.message ?? "")) {
            reject(
              new AiError(
                "missing-binary",
                `${provider} CLI not found ("${bin}") — install it, or pick another provider in Settings → AI`,
              ),
            );
            return;
          }
          reject(new AiError("provider-failed", `${provider} CLI failed: ${detail || "unknown error"}`));
          return;
        }
        resolve(stdout);
      },
    );
    // Close stdin immediately. These are one-shot invocations with the prompt
    // in argv, but execFile leaves stdin an open pipe, and a CLI that checks
    // for piped input waits on it: `codex exec` prints "Reading additional
    // input from stdin..." and hangs until the timeout, yielding nothing.
    // EOF up front makes that instant (90s to 0.1s), and is harmless for the
    // providers that never read stdin.
    child.stdin?.end();
  });
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, provider: string) {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new AiError("provider-failed", `${provider} request failed: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    // Provider error bodies can echo the request, so only a short prefix is
    // surfaced — never the whole body, and never the key.
    throw new AiError("provider-failed", `${provider} returned ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AiError("provider-failed", `${provider} returned a non-JSON response`);
  }
}

// A key is mandatory against the vendors' own endpoints, but a custom base
// URL is often something that needs no auth at all (a local Ollama or
// llama.cpp), so there it is optional and the auth header is simply omitted.
async function resolveKey(profile: AiProfile, custom: boolean): Promise<string> {
  const secrets = await readAiSecrets();
  // Keyed by profile id, so two profiles of the same wire format (OpenAI
  // itself and an OpenRouter endpoint, say) hold different keys. The
  // provider-keyed entry is where every key lived before profiles existed —
  // still read, so an upgrade doesn't ask for keys again.
  const key = secrets[profile.id] ?? secrets[profile.provider];
  if (!key && !custom) {
    throw new AiError(
      "missing-key",
      `No API key configured for "${profile.label}" — add one in Settings → AI`,
    );
  }
  return key ?? "";
}

async function runAnthropic(prompt: string, model: string, profile: AiProfile): Promise<string> {
  const baseUrl = profile.baseUrl;
  const key = await resolveKey(profile, !!baseUrl);
  const data = await postJson(
    endpoint(baseUrl, ANTHROPIC_DEFAULT_BASE, "messages"),
    { ...(key ? { "x-api-key": key } : {}), "anthropic-version": ANTHROPIC_VERSION },
    {
      model: model || ANTHROPIC_DEFAULT_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: prompt }],
    },
    "anthropic",
  );
  const content = Array.isArray(data.content) ? (data.content as { type?: string; text?: string }[]) : [];
  return content.find((block) => block.type === "text")?.text ?? "";
}

async function runOpenai(prompt: string, model: string, profile: AiProfile): Promise<string> {
  if (!model) {
    throw new AiError("missing-model", "The OpenAI provider needs a model — set one in Settings → AI");
  }
  const baseUrl = profile.baseUrl;
  const key = await resolveKey(profile, !!baseUrl);
  const data = await postJson(
    endpoint(baseUrl, OPENAI_DEFAULT_BASE, "chat/completions"),
    key ? { authorization: `Bearer ${key}` } : {},
    { model, messages: [{ role: "user", content: prompt }] },
    "openai",
  );
  const choices = Array.isArray(data.choices)
    ? (data.choices as { message?: { content?: string } }[])
    : [];
  return choices[0]?.message?.content ?? "";
}

// ---- Model discovery ----
// Both API formats expose the same route — GET {base}/models, returning
// {data: [...]} — so the Model field can offer the endpoint's own list
// instead of asking people to type an id from memory. Which endpoint that
// is follows the profile's base URL, so an OpenAI-compatible service
// (OpenRouter, Groq, Together, a local Ollama) lists ITS models, not
// OpenAI's.
//
// A CLI has no such route, so each one is asked the way it actually answers
// — see listCliModels. A custom command is the only provider with no answer
// at all: it's a command line the user wrote.

export interface AiModelOption {
  id: string;
  // Anthropic returns a display_name ("Claude Opus 5"); OpenAI-format
  // endpoints return the id alone.
  label?: string;
}

// Anthropic's list is paginated (has_more/last_id). A few pages is plenty
// for a picker — nobody scrolls 500 models — and it bounds a slow endpoint.
const MODEL_PAGE_LIMIT = 100;
const MODEL_MAX_PAGES = 3;

async function getJson(
  url: string,
  headers: Record<string, string>,
  provider: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new AiError("provider-failed", `${provider} request failed: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new AiError("provider-failed", `${provider} returned ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AiError("provider-failed", `${provider} returned a non-JSON response`);
  }
}

function modelsFromData(data: unknown): AiModelOption[] {
  if (!Array.isArray(data)) return [];
  const out: AiModelOption[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    if (!id) continue;
    const display = typeof row.display_name === "string" ? row.display_name : "";
    out.push(display && display !== id ? { id, label: display } : { id });
  }
  return out;
}

// ---- CLI model discovery ----
// No standard exists, so each CLI is asked the way it actually answers,
// checked against the installed binaries (2026-09-11):
//
//   agy     `agy models` prints "<id>\t<label>" per line, after a
//           "Fetching available models..." preamble — a real list.
//   claude  no models command, but its `--model` help documents what it
//           takes ("an alias ... 'fable', 'opus', or 'sonnet' ... or a
//           model's full name (e.g. 'claude-fable-5')"), so the quoted
//           tokens in that paragraph ARE the answer.
//   codex   neither: `-m/--model` is documented as "Model the agent should
//           use", naming nothing — so this returns an empty list and the
//           field says so rather than inventing ids.
//
// Best-effort by nature: a CLI that rewords its help or drops a subcommand
// yields an empty list, never a crash and never a guess.

const CLI_LIST_TIMEOUT_MS = 20_000;
// Provider → the subcommand that prints a model list, for those that have one.
const CLI_LIST_COMMAND: Record<string, string[]> = { agy: ["models"] };

function runCliCapture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { encoding: "utf8", timeout: CLI_LIST_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout) => {
        // Help text often exits non-zero, and an unknown subcommand isn't
        // worth an error here — whatever was printed is what gets parsed.
        resolve(err && !stdout ? "" : stdout);
      },
    );
    child.stdin?.end();
  });
}

// "<id>\t<label>" lines, ignoring everything else the command prints.
function parseCliModelLines(out: string): AiModelOption[] {
  const models: AiModelOption[] = [];
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    if (!id || /\s/.test(id)) continue;
    models.push(label && label !== id ? { id, label } : { id });
  }
  return models;
}

// The quoted tokens inside a CLI's own --model help — the names it
// documents. Anything containing whitespace or a period is prose, not an id.
function parseHelpModelNames(out: string): AiModelOption[] {
  const paragraph = /--model[^\n]*\n(?:[ \t]{2,}[^\n]*\n)*/.exec(out)?.[0] ?? "";
  const ids = new Set<string>();
  for (const match of paragraph.matchAll(/'([^']{2,60})'/g)) {
    const id = match[1].trim();
    if (id && !/[\s.]/.test(id)) ids.add(id);
  }
  return [...ids].map((id) => ({ id }));
}

async function listCliModels(profile: AiProfile): Promise<AiModelOption[]> {
  const cli = CLI_PROVIDERS[profile.provider];
  const bin = profile.binaryPath || cli?.bin || profile.provider;
  const listCommand = CLI_LIST_COMMAND[profile.provider];
  if (listCommand) {
    const models = parseCliModelLines(await runCliCapture(bin, listCommand));
    if (models.length > 0) return models;
  }
  // The help text is the fallback: for a CLI with no list subcommand, and
  // for one whose subcommand printed nothing usable (not signed in, offline).
  return parseHelpModelNames(await runCliCapture(bin, ["--help"]));
}

// The models the profile's own endpoint offers. Throws AiError — the same
// typed codes runAi uses, so the caller tells "no key yet" from "the
// endpoint broke" from "this provider has no such list".
export async function listProviderModels(profileId?: string): Promise<AiModelOption[]> {
  const profile = await resolveProfile(profileId);
  if (profile.provider === "anthropic") {
    const key = await resolveKey(profile, !!profile.baseUrl);
    const models: AiModelOption[] = [];
    let after = "";
    for (let page = 0; page < MODEL_MAX_PAGES; page++) {
      const url = new URL(endpoint(profile.baseUrl, ANTHROPIC_DEFAULT_BASE, "models"));
      url.searchParams.set("limit", String(MODEL_PAGE_LIMIT));
      if (after) url.searchParams.set("after_id", after);
      const data = await getJson(
        url.toString(),
        { ...(key ? { "x-api-key": key } : {}), "anthropic-version": ANTHROPIC_VERSION },
        "anthropic",
      );
      models.push(...modelsFromData(data.data));
      const lastId = typeof data.last_id === "string" ? data.last_id : "";
      if (data.has_more !== true || !lastId) break;
      after = lastId;
    }
    return models;
  }
  if (profile.provider === "openai") {
    const key = await resolveKey(profile, !!profile.baseUrl);
    const data = await getJson(
      endpoint(profile.baseUrl, OPENAI_DEFAULT_BASE, "models"),
      key ? { authorization: `Bearer ${key}` } : {},
      "openai",
    );
    // Alphabetical: this route returns creation order, which for a big
    // catalogue reads as random.
    return modelsFromData(data.data).sort((a, b) => a.id.localeCompare(b.id));
  }
  if (profile.provider === "custom") {
    throw new AiError(
      "unsupported",
      `"${profile.label}" is a command line you wrote — only you know which models it takes.`,
    );
  }
  return listCliModels(profile);
}

// Models wrap a reply in a code fence even when told not to. Only a fence on
// the very first and very last line is stripped, so a reply that legitimately
// quotes a fenced block keeps it.
function stripWrappingFence(reply: string): string {
  const lines = reply.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines.length >= 2 && /^```/.test(lines[0]) && /^```\s*$/.test(lines[lines.length - 1])) {
    return lines.slice(1, -1).join("\n").trim();
  }
  return lines.join("\n").trim();
}

export interface AiRunOptions {
  // Which configured AI to use (see listAiProfiles). Omitted — or naming a
  // profile the user has since removed or disabled — falls back to the
  // default profile.
  profileId?: string;
  // Overrides the profile's own model for this one call — for a caller whose
  // task wants a different size of model than the user's default.
  model?: string;
  // Working directory for a CLI provider. Some CLIs refuse to run outside a
  // trusted directory ("Not inside a trusted directory" from `codex exec`),
  // so a caller that knows which project it is acting on should say so rather
  // than inherit wherever the server happens to have been started. Ignored by
  // the API providers, which have no notion of a working directory.
  cwd?: string;
}

// Prompt in, text out. Throws AiError; never returns an empty string.
export async function runAi(prompt: string, opts: AiRunOptions = {}): Promise<string> {
  if (!prompt.trim()) throw new AiError("provider-failed", "prompt is empty");
  const profile = await resolveProfile(opts.profileId);
  const model = opts.model?.trim() || profile.model;

  let raw: string;
  if (profile.provider === "anthropic") {
    raw = await runAnthropic(prompt, model, profile);
  } else if (profile.provider === "openai") {
    raw = await runOpenai(prompt, model, profile);
  } else if (profile.provider === "custom") {
    if (!profile.customCommand) {
      throw new AiError(
        "missing-command",
        `"${profile.label}" needs a command — set one in Settings → AI`,
      );
    }
    // The user's own command line, run via sh with the prompt appended as its
    // single argument ($0 of the -c script) — quoting inside the command is
    // theirs, and the prompt itself never needs any.
    raw = await runCli("/bin/sh", ["-c", `${profile.customCommand} "$0"`, prompt], "custom", opts.cwd);
  } else {
    const cli = CLI_PROVIDERS[profile.provider] ?? CLI_PROVIDERS.claude;
    raw = await runCli(profile.binaryPath || cli.bin, cli.args(prompt, model), profile.provider, opts.cwd);
  }

  const text = stripWrappingFence(raw);
  if (!text) throw new AiError("empty-reply", `${profile.label} returned an empty reply`);
  return text;
}

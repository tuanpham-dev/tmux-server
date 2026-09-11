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
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

export type AiErrorCode =
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

interface AiConfig {
  provider: string;
  binaryPath: string;
  model: string;
  customCommand: string;
  baseUrl: string;
}

async function readAiConfig(): Promise<AiConfig> {
  const doc = await readSettingsDoc();
  const settings = (doc.settings ?? {}) as Record<string, unknown>;
  const read = (key: string): string => (typeof settings[key] === "string" ? (settings[key] as string).trim() : "");
  return {
    provider: read("aiProvider") || "claude",
    binaryPath: read("aiBinaryPath"),
    model: read("aiModel"),
    customCommand: read("aiCustomCommand"),
    baseUrl: read("aiBaseUrl"),
  };
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
async function resolveKey(provider: "anthropic" | "openai", custom: boolean): Promise<string> {
  const key = (await readAiSecrets())[provider];
  if (!key && !custom) {
    throw new AiError("missing-key", `No ${provider} API key configured — add one in Settings → AI`);
  }
  return key ?? "";
}

async function runAnthropic(prompt: string, model: string, baseUrl: string): Promise<string> {
  const key = await resolveKey("anthropic", !!baseUrl);
  const data = await postJson(
    endpoint(baseUrl, ANTHROPIC_DEFAULT_BASE, "messages"),
    { ...(key ? { "x-api-key": key } : {}), "anthropic-version": "2023-06-01" },
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

async function runOpenai(prompt: string, model: string, baseUrl: string): Promise<string> {
  if (!model) {
    throw new AiError("missing-model", "The OpenAI provider needs a model — set one in Settings → AI");
  }
  const key = await resolveKey("openai", !!baseUrl);
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
  // Overrides the configured aiModel for this one call — for a caller whose
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
  const config = await readAiConfig();
  const model = opts.model?.trim() || config.model;

  let raw: string;
  if (config.provider === "anthropic") {
    raw = await runAnthropic(prompt, model, config.baseUrl);
  } else if (config.provider === "openai") {
    raw = await runOpenai(prompt, model, config.baseUrl);
  } else if (config.provider === "custom") {
    if (!config.customCommand) {
      throw new AiError(
        "missing-command",
        "The custom provider needs a command — set one in Settings → AI",
      );
    }
    // The user's own command line, run via sh with the prompt appended as its
    // single argument ($0 of the -c script) — quoting inside the command is
    // theirs, and the prompt itself never needs any.
    raw = await runCli("/bin/sh", ["-c", `${config.customCommand} "$0"`, prompt], "custom", opts.cwd);
  } else {
    const cli = CLI_PROVIDERS[config.provider] ?? CLI_PROVIDERS.claude;
    raw = await runCli(config.binaryPath || cli.bin, cli.args(prompt, model), config.provider, opts.cwd);
  }

  const text = stripWrappingFence(raw);
  if (!text) throw new AiError("empty-reply", `${config.provider} returned an empty reply`);
  return text;
}

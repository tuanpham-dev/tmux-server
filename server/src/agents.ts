// The app's one agent registry. "What is an AI agent" used to be answered in
// seven places at once — four comma-separated detection settings
// (agentMonitor.programs, gitScm.agentPrograms, livePreview.agentPrograms,
// ports.agentPrograms) and three launch-preset lists (github.agents,
// jira.agents, agentTasks.agents) — so the same CLI had to be named again in
// every extension that cared (plans/agent-platform-core.md).
//
// One entry answers all of it, because the three facts always travel
// together:
//   program   what tmux reports as the pane's foreground command, which is
//             how "which window is the agent in" is decided (detection).
//   command   the full launch line, which is what a "Start work" preset
//             types into a fresh session (launch).
//   hooks     which hook schema the CLI speaks, which is what lets core
//             generate and install its own hook for it (agentHooks.ts).
//
// A sibling of an existing core concept rather than a new one: ai.ts already
// names claude / codex / agy as AI providers, and reads its own list out of
// the settings document exactly the same way.
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isOnPath } from "./ai.js";
import { readSettingsDoc } from "./settingsStore.js";

// Which hook config schema an agent's CLI speaks. Only these three are
// known; null means "this agent has no hooks core can install" (a wrapper
// script, a CLI that has none), which is a first-class state — such an
// entry is still a perfectly good detection and launch preset.
export type AgentHookFlavor = "claude" | "codex" | "agy";

const HOOK_FLAVORS: readonly string[] = ["claude", "codex", "agy"];

// One agent, as Settings → Agents lists them.
export interface AgentPreset {
  // Stable across renames: what an extension stores when it picks one, and
  // what the hook routes address. Safe as a plain object key.
  id: string;
  label: string;
  // tmux's pane_current_command for a pane running this agent. Empty means
  // "launch preset only" — nothing will ever be detected as this agent.
  program: string;
  // The full command line that starts it. Empty means "detection only".
  command: string;
  // The argument(s) appended to `command` to start this agent with its
  // permission prompts off - its "yolo mode". A parameter rather than a
  // second registry entry, because every agent has one and the pair only
  // ever differed by this flag: two entries meant the same CLI listed twice,
  // with the same program, the same hooks and the same everything else.
  // Empty means this agent has no such mode and the checkbox is not offered.
  skipPermissionsArgs: string;
  hooks: AgentHookFlavor | null;
  // Where to read about this agent, or how to install it - the row's
  // external-link button in Settings → Agents, and the only useful thing to
  // offer for an agent whose CLI is not on the machine yet. Empty hides the
  // link.
  docsUrl: string;
  // An image for the agent's row. Core's own agents point at files the app
  // serves (/agents/<id>.svg); a contributed agent may give an absolute URL
  // or a path inside its own extension, which is resolved to that
  // extension's file route before it reaches a client. Empty falls back to
  // `icon` below.
  iconUrl: string;
  // Fallback for an agent with no image: a codicon name from the set the app
  // already ships (see client/src/components/Icon.tsx). Anything empty or
  // unknown renders the generic robot rather than leaving a hole in the row.
  icon: string;
  // An agent kept but not offered: it stays configured and stops showing up
  // in pickers and in detection.
  enabled: boolean;
  // The extension that contributed this entry, or "" for one core ships or
  // the user wrote. Contributed entries are not editable in Settings -
  // whoever contributed them owns their command line - but they can be
  // enabled and disabled like any other.
  contributedBy: string;
}

// The seed for a settings document that has never stored a list: the three
// CLIs core already knows as AI providers, one entry each. Each carries its
// own skip-permissions flag, verified against the installed binaries on
// 2026-09-11 (`--help`) rather than copied from documentation - Codex spells
// it differently from the other two.
export const DEFAULT_AGENTS: readonly AgentPreset[] = [
  {
    id: "claude",
    label: "Claude Code",
    program: "claude",
    command: "claude",
    skipPermissionsArgs: "--dangerously-skip-permissions",
    hooks: "claude",
    docsUrl: "https://docs.claude.com/en/docs/claude-code",
    iconUrl: "/agents/claude.svg",
    icon: "sparkle",
    enabled: true,
    contributedBy: "",
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    program: "codex",
    command: "codex",
    skipPermissionsArgs: "--dangerously-bypass-approvals-and-sandbox",
    hooks: "codex",
    docsUrl: "https://github.com/openai/codex",
    iconUrl: "/agents/codex.svg",
    icon: "hubot",
    enabled: true,
    contributedBy: "",
  },
  {
    id: "agy",
    label: "Antigravity",
    program: "agy",
    command: "agy",
    skipPermissionsArgs: "--dangerously-skip-permissions",
    hooks: "agy",
    docsUrl: "https://antigravity.google/docs/cli",
    iconUrl: "/agents/agy.png",
    icon: "rocket",
    enabled: true,
    contributedBy: "",
  },
];

// What a row shows for an agent that named no icon of its own.
export const DEFAULT_AGENT_ICON = "hubot";

function readString(source: Record<string, unknown>, key: string): string {
  return typeof source[key] === "string" ? (source[key] as string).trim() : "";
}

function parseAgent(raw: unknown): AgentPreset | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const id = readString(source, "id");
  const program = readString(source, "program");
  const command = readString(source, "command");
  // An entry that can neither be detected nor launched is not an agent, and
  // an id is what everything else addresses it by.
  if (!id || (!program && !command)) return null;
  const hooks = readString(source, "hooks");
  const shipped = DEFAULT_AGENTS.find((a) => a.id === id);
  return {
    id,
    label: readString(source, "label") || program || command,
    program,
    command,
    skipPermissionsArgs: readString(source, "skipPermissionsArgs"),
    hooks: HOOK_FLAVORS.includes(hooks) ? (hooks as AgentHookFlavor) : null,
    // Presentation only, and filled in from what the app ships for this id
    // when the stored entry has none: a document written before these
    // existed - every profile that has ever saved settings - would otherwise
    // show a blank row forever. A stored value always wins.
    docsUrl: readString(source, "docsUrl") || shipped?.docsUrl || "",
    iconUrl: readString(source, "iconUrl") || shipped?.iconUrl || "",
    icon: readString(source, "icon") || shipped?.icon || DEFAULT_AGENT_ICON,
    // Absent means enabled: the settings UI always writes the flag, and a
    // hand-edited entry that left it out means "use it".
    enabled: source.enabled !== false,
    contributedBy: readString(source, "contributedBy"),
  };
}

// Agents contributed by extensions (manifest `contributes.agents`), supplied
// by extensions.ts at import time rather than imported from it: the
// extension host already depends on this module for host.agents, so reaching
// back would be a cycle. An installed provider is the only way contributed
// entries reach the registry, and with none installed the registry is
// exactly what it was.
let contributedAgentsSource: () => Promise<AgentPreset[]> = async () => [];

export function setContributedAgentsSource(source: () => Promise<AgentPreset[]>): void {
  contributedAgentsSource = source;
}

// The whole registry, disabled entries included: what the settings document
// holds, plus whatever extensions contribute. An absent or non-array
// `agents` key means "never configured" and seeds from DEFAULT_AGENTS; a
// stored array is taken at face value, empty included, so a user who
// deliberately deletes every agent is not handed the defaults back.
//
// A stored entry WINS over a contributed one with the same id, which is what
// makes "disable this plugin's agent" work: the panel writes the entry back
// with enabled:false and that override survives.
export async function resolveAgents(): Promise<AgentPreset[]> {
  const doc = await readSettingsDoc();
  const settings = (doc.settings ?? {}) as Record<string, unknown>;
  const raw = settings.agents;
  const stored = Array.isArray(raw)
    ? raw.map(parseAgent).filter((a): a is AgentPreset => a !== null)
    : DEFAULT_AGENTS.map((a) => ({ ...a }));
  let contributed: AgentPreset[] = [];
  try {
    contributed = await contributedAgentsSource();
  } catch (err) {
    // A broken manifest must not take the registry down with it.
    console.error("failed to read contributed agents:", err);
  }
  const ids = new Set(stored.map((a) => a.id));
  return [...stored, ...contributed.filter((a) => !ids.has(a.id))];
}

// Which of the registry's programs are actually on this machine, so Settings
// → Agents can dim an agent whose CLI is not installed rather than offering
// it as if it would work. Keyed by agent id; an entry with no program is
// never "installed" because there is nothing to look for.
export async function probeAgentPrograms(): Promise<Record<string, boolean>> {
  const agents = await resolveAgents();
  const found: Record<string, boolean> = {};
  await Promise.all(
    agents.map(async (agent) => {
      found[agent.id] = agent.program ? await isOnPath(agent.program) : false;
    }),
  );
  return found;
}

// What a caller may choose between, or match a pane against: the enabled
// entries, in the user's own order. `enabled` is not carried — everything
// in this list is.
export interface AgentSummary {
  id: string;
  label: string;
  program: string;
  command: string;
  // Appended to `command` when the caller offers a "skip permissions" choice
  // and the user takes it. Empty means this agent has no such mode.
  skipPermissionsArgs: string;
  hooks: AgentHookFlavor | null;
}

export async function listAgents(): Promise<AgentSummary[]> {
  const agents = await resolveAgents();
  return agents
    .filter((a) => a.enabled)
    .map(({ id, label, program, command, skipPermissionsArgs, hooks }) => ({
      id,
      label,
      program,
      command,
      skipPermissionsArgs,
      hooks,
    }));
}

// One agent by id, disabled ones included — the hook routes address an agent
// directly and must still be able to uninstall hooks for one the user has
// since switched off.
export async function findAgent(id: string): Promise<AgentPreset | undefined> {
  const agents = await resolveAgents();
  return agents.find((a) => a.id === id);
}

// ---- Hook schemas -------------------------------------------------------
// Everything below is per-agent knowledge of how that CLI wants its hooks
// written: which file, in what shape, and what it calls each event. Verified
// against the installed binaries on 2026-09-11 — see the notes on each
// flavour. It lives here, beside the registry, because "which hook schema
// does this agent speak" is one of the three facts a registry entry carries.

// The events core normalizes to, and the only names a subscriber ever sees.
// One vocabulary across three CLIs that each spell them differently, so an
// extension subscribing to "stop" gets Claude's Stop, Codex's Stop and
// Antigravity's Stop without knowing any of that.
export type AgentEvent =
  | "session-start"
  | "prompt-submit"
  | "tool-start"
  | "tool-end"
  | "permission"
  | "stop"
  | "subagent-stop";

// Fire once per tool call rather than once per turn. Gated behind the
// agentHooksHighFrequencyEvents setting: a subscriber may ask for them, but
// core does not install them until the user opts in.
export const HIGH_FREQUENCY_EVENTS: readonly AgentEvent[] = ["tool-start", "tool-end"];

// normalized event -> the raw event name that agent's CLI uses. An event
// missing from a flavour's table is one that CLI does not deliver, so core
// never installs it and never claims it can: agy has no permission event and
// no working tool events at all (see below), which is why its table is short.
//
// This table is also the normalizer's dictionary (agentHooks.ts reads it
// backwards), so a raw event core does not know about — agy's
// PostInvocation, a name a future release adds — resolves to no normalized
// event and is delivered with `event: null` rather than guessed at.
const EVENT_NAMES: Record<AgentHookFlavor, Partial<Record<AgentEvent, string>>> = {
  // Claude Code: merged into the top-level "hooks" key of
  // ~/.claude/settings.json. Tool events take a matcher; the turn-level ones
  // do not.
  claude: {
    "session-start": "SessionStart",
    "prompt-submit": "UserPromptSubmit",
    "tool-start": "PreToolUse",
    "tool-end": "PostToolUse",
    permission: "Notification",
    stop: "Stop",
    "subagent-stop": "SubagentStop",
  },
  // Codex: its own whole file, ~/.codex/hooks.json. Same event names as
  // Claude except PermissionRequest in place of Notification. The schema is
  // confirmed by experiment; whether Stop actually fires was not verifiable
  // (see the plan's open questions).
  codex: {
    "session-start": "SessionStart",
    "prompt-submit": "UserPromptSubmit",
    "tool-start": "PreToolUse",
    "tool-end": "PostToolUse",
    permission: "PermissionRequest",
    stop: "Stop",
    "subagent-stop": "SubagentStop",
  },
  // Antigravity CLI 1.2.1, established by firing hooks rather than by its
  // docs: SessionStart (undocumented but works), PreInvocation and
  // PostInvocation (once per model turn each) and Stop are the only events
  // that fire. PreToolUse/PostToolUse are documented but inert — a real Bash
  // call fired neither — and there is no permission event at all: with a
  // permission prompt on screen neither PermissionRequest nor Notification
  // fired. The CLI also accepts unknown event names silently, so a config it
  // loads without complaint proves nothing; only firing does.
  //
  // PreInvocation is mapped to prompt-submit because it is what marks the
  // start of a turn for agy. PostInvocation is deliberately absent: it fires
  // when the model's tool calls are done, which is neither tool-end nor
  // stop, so it arrives normalized to null with its raw name intact.
  agy: {
    "session-start": "SessionStart",
    "prompt-submit": "PreInvocation",
    stop: "Stop",
  },
};

// Claude's tool events are the only ones anywhere that take a matcher, and
// "*" is how you say "every tool".
const CLAUDE_MATCHED_EVENTS: readonly string[] = ["PreToolUse", "PostToolUse"];

// Seconds. Generous next to the shim's own `curl -m 2` — the number is only
// ever reached if the whole shim hangs, and a hook that times out is an agent
// that stalls, so it errs long rather than tight.
const HOOK_TIMEOUT_SECONDS = 5;

// Core's key inside agy's named-wrapper file. Also what tells core's own
// wrapper apart from the user's when reading that file back.
export const AGY_HOOK_NAME = "tmux-server";

// The one line core ever asks an agent to run. Written at boot by
// agentHooks.ts (which owns the script's contents); the path is here because
// it is also core's signature in an agent's config file — the writer
// recognizes its own entries by this path and nothing else, which is what
// keeps a hand-written hook from ever being read, rewritten or removed.
export const agentHookShimPath = path.join(
  process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
  "tmux-server",
  "bin",
  "agent-hook",
);

// An id safe to put in a hook command's argument list, and safe as a plain
// object key. Ids come from a user-editable settings document, and the
// generated command is executed by the agent, so anything outside this
// alphabet is refused rather than escaped.
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function isSafeAgentId(id: string): boolean {
  return SAFE_ID.test(id) && id !== "__proto__";
}

// The command an agent's hook entry runs: the shim, the agent it fired for,
// and the agent's own event name. The event JSON goes to the shim on stdin,
// and $TMUX_PANE is read from the pane's environment — nothing about the
// event is interpolated here.
export function hookCommandFor(agentId: string, rawEvent: string): string {
  return `${agentHookShimPath} ${agentId} ${rawEvent}`;
}

// Which of `events` this agent can actually deliver, as its own raw names,
// in a stable order so two calls produce comparable results (the stale check
// in hookState compares these sets).
export function rawEventsFor(flavor: AgentHookFlavor, events: readonly AgentEvent[]): string[] {
  const table = EVENT_NAMES[flavor];
  const names = new Set<string>();
  for (const event of events) {
    const raw = table[event];
    if (raw) names.add(raw);
  }
  return [...names].sort();
}

// The reverse of EVENT_NAMES, for agentHooks.ts's normalizer. A raw name
// this flavour has no entry for returns null — the event is still delivered,
// just unnormalized.
export function normalizeRawEvent(flavor: AgentHookFlavor, rawEvent: string): AgentEvent | null {
  for (const [event, raw] of Object.entries(EVENT_NAMES[flavor])) {
    if (raw === rawEvent) return event as AgentEvent;
  }
  return null;
}

export interface HookSnippet {
  // Absolute path of the file this belongs in.
  file: string;
  // "merged" — the file holds other things and core only adds its own part
  // (Claude's settings.json, or core's own named wrapper inside agy's
  // hooks.json). "whole-file" — the snippet IS the file's entire contents,
  // so pasting it over an existing one would discard whatever was there and
  // the UI has to say so (Codex).
  ownership: "merged" | "whole-file";
  // The exact text to paste, newline-terminated.
  text: string;
  // The raw event names this snippet registers, for the UI and for the
  // install/stale bookkeeping.
  rawEvents: string[];
}

function claudeSnippet(agentId: string, rawEvents: string[]): string {
  const hooks: Record<string, unknown[]> = {};
  for (const raw of rawEvents) {
    const entry: Record<string, unknown> = {};
    // Only the tool events take a matcher, and leaving it off the others
    // keeps the snippet to exactly what that event accepts.
    if (CLAUDE_MATCHED_EVENTS.includes(raw)) entry.matcher = "*";
    entry.hooks = [{ type: "command", command: hookCommandFor(agentId, raw), timeout: HOOK_TIMEOUT_SECONDS }];
    hooks[raw] = [entry];
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

function codexSnippet(agentId: string, rawEvents: string[]): string {
  const hooks: Record<string, unknown[]> = {};
  for (const raw of rawEvents) {
    hooks[raw] = [
      { hooks: [{ type: "command", command: hookCommandFor(agentId, raw), timeout: HOOK_TIMEOUT_SECONDS }] },
    ];
  }
  // No matcher and no named wrapper: a named wrapper is rejected at startup
  // with "unknown field, expected 'description' or 'hooks'".
  return `${JSON.stringify({ description: "tmux-server agent hooks", hooks }, null, 2)}\n`;
}

function agySnippet(agentId: string, rawEvents: string[]): string {
  // A named wrapper whose event value is a FLAT array of handlers — no
  // matcher and, unlike both other agents, no nested "hooks" array. Supplying
  // one is rejected with: invalid hook "<name>": command hook must specify
  // 'command'. Antigravity's published docs show the nested form and are
  // wrong; ~/.gemini/antigravity-cli/cli.log is the authority on what the
  // parser actually accepted.
  const wrapper: Record<string, unknown> = { enabled: true };
  for (const raw of rawEvents) {
    wrapper[raw] = [{ type: "command", command: hookCommandFor(agentId, raw), timeout: HOOK_TIMEOUT_SECONDS }];
  }
  return `${JSON.stringify({ [AGY_HOOK_NAME]: wrapper }, null, 2)}\n`;
}

// Where each flavour keeps its hooks. agy also loads a workspace
// .agents/hooks.json; core writes the home one, which applies everywhere.
export function hookFileFor(flavor: AgentHookFlavor): string {
  const home = homedir();
  switch (flavor) {
    case "claude":
      return path.join(home, ".claude", "settings.json");
    case "codex":
      return path.join(home, ".codex", "hooks.json");
    case "agy":
      return path.join(home, ".gemini", "config", "hooks.json");
  }
}

// The snippet for one agent and one set of normalized events, or null when
// there is nothing to generate: an agent with no hook flavour, an unsafe id,
// or a set of events this agent cannot deliver any of.
export function snippetFor(agent: AgentPreset, events: readonly AgentEvent[]): HookSnippet | null {
  if (!agent.hooks || !isSafeAgentId(agent.id)) return null;
  const rawEvents = rawEventsFor(agent.hooks, events);
  if (rawEvents.length === 0) return null;
  const file = hookFileFor(agent.hooks);
  switch (agent.hooks) {
    case "claude":
      return { file, ownership: "merged", text: claudeSnippet(agent.id, rawEvents), rawEvents };
    case "codex":
      return { file, ownership: "whole-file", text: codexSnippet(agent.id, rawEvents), rawEvents };
    case "agy":
      return { file, ownership: "merged", text: agySnippet(agent.id, rawEvents), rawEvents };
  }
}

// ---- The writer ---------------------------------------------------------
// Core writing into a file it does not own (an agent's own config, in the
// user's home) is the one place in this app that does that, so the rules are
// strict and they are all here:
//
//   Only from an explicit user action. Nothing below runs at boot or on a
//   settings change — only POST /api/agent-hooks/install and its sibling.
//
//   Only core's own entries are ever read, replaced or removed, and "core's
//   own" means exactly one thing: the command starts with core's shim path.
//   A hand-written hook is never touched, whatever it points at, and
//   installing twice replaces core's entry in place rather than adding a
//   second.
//
//   A timestamped backup beside the file first, then temp-then-rename, so a
//   crash mid-write cannot leave a user without their agent's settings.

// What agent-monitor's own pasted snippet used to curl, before core took the
// pipeline over. Finding one means the user has a hook that stopped working
// when agent-monitor dropped that route, which is worth saying out loud
// rather than leaving to a changelog line.
//
// Matched loosely on purpose: an extension route is mounted at
// /api/ext/<publisher>.<name>/, so the snippet a user actually pasted says
// "tmux-server.agent-monitor" — and a sideloaded or renamed copy says
// something else again. The route name is the part that identifies it.
const LEGACY_MONITOR_COMMAND = /\/api\/ext\/[^/]*agent-monitor\/event/;

function isCoreHookCommand(command: unknown): boolean {
  return typeof command === "string" && command.startsWith(`${agentHookShimPath} `);
}

// The agent id core's own command was installed for. Hooks are per config
// FILE, so two registry entries sharing a CLI (the two Claude Code presets)
// share one installed entry, and this is whichever of them was installed
// last — see hookStateFor's stale check.
function coreHookAgentId(command: string): string {
  return command.slice(agentHookShimPath.length + 1).split(" ")[0] ?? "";
}

function isLegacyMonitorCommand(command: unknown): boolean {
  return typeof command === "string" && LEGACY_MONITOR_COMMAND.test(command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Claude and Codex share one shape: a map of event name to a list of
// entries, each entry holding a list of {type, command, timeout} handlers
// (Claude's tool entries also carry a matcher, which is preserved as-is on
// anything core did not write). Antigravity's is the odd one and is handled
// separately.
interface NestedScan {
  // Raw event names core's own handlers are registered for.
  coreEvents: string[];
  // Agent ids core's installed handlers name.
  coreAgentIds: string[];
  legacyFound: boolean;
}

function scanNested(hooks: Record<string, unknown>): NestedScan {
  const coreEvents: string[] = [];
  const coreAgentIds = new Set<string>();
  let legacyFound = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    let hasCore = false;
    for (const entry of entries) {
      const handlers = isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : [];
      for (const handler of handlers) {
        const command = isRecord(handler) ? handler.command : undefined;
        if (isCoreHookCommand(command)) {
          hasCore = true;
          coreAgentIds.add(coreHookAgentId(command as string));
        }
        if (isLegacyMonitorCommand(command)) legacyFound = true;
      }
    }
    if (hasCore) coreEvents.push(event);
  }
  return { coreEvents: coreEvents.sort(), coreAgentIds: [...coreAgentIds], legacyFound };
}

// Drops every entry core wrote, leaving everything else — including an entry
// that mixes a core handler with a hand-written one, where only the core
// handler goes — and prunes an event whose list ends up empty so the file
// does not accumulate dead keys.
function stripNestedCoreEntries(hooks: Record<string, unknown>): void {
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept: unknown[] = [];
    for (const entry of entries) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
        kept.push(entry);
        continue;
      }
      const handlers = entry.hooks.filter((handler) => !isCoreHookCommand(isRecord(handler) ? handler.command : undefined));
      if (handlers.length === entry.hooks.length) {
        kept.push(entry);
      } else if (handlers.length > 0) {
        kept.push({ ...entry, hooks: handlers });
      }
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
}

function nestedEntryFor(flavor: AgentHookFlavor, agentId: string, rawEvent: string): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (flavor === "claude" && CLAUDE_MATCHED_EVENTS.includes(rawEvent)) entry.matcher = "*";
  entry.hooks = [{ type: "command", command: hookCommandFor(agentId, rawEvent), timeout: HOOK_TIMEOUT_SECONDS }];
  return entry;
}

// agy's named wrappers: core owns the one called AGY_HOOK_NAME, and
// recognizes a wrapper as its own only by the commands inside it — so a
// wrapper under that name that points somewhere else is someone else's and
// is left completely alone (installHooks refuses rather than replacing it).
function isCoreAgyWrapper(wrapper: unknown): boolean {
  if (!isRecord(wrapper)) return false;
  let sawHandler = false;
  for (const [key, handlers] of Object.entries(wrapper)) {
    if (key === "enabled" || !Array.isArray(handlers)) continue;
    for (const handler of handlers) {
      sawHandler = true;
      if (!isCoreHookCommand(isRecord(handler) ? handler.command : undefined)) return false;
    }
  }
  return sawHandler;
}

function scanAgy(doc: Record<string, unknown>): NestedScan {
  const coreEvents = new Set<string>();
  const coreAgentIds = new Set<string>();
  let legacyFound = false;
  for (const wrapper of Object.values(doc)) {
    if (!isRecord(wrapper)) continue;
    for (const [key, handlers] of Object.entries(wrapper)) {
      if (key === "enabled" || !Array.isArray(handlers)) continue;
      for (const handler of handlers) {
        const command = isRecord(handler) ? handler.command : undefined;
        if (isCoreHookCommand(command)) {
          coreEvents.add(key);
          coreAgentIds.add(coreHookAgentId(command as string));
        }
        if (isLegacyMonitorCommand(command)) legacyFound = true;
      }
    }
  }
  return { coreEvents: [...coreEvents].sort(), coreAgentIds: [...coreAgentIds], legacyFound };
}

export class HookWriteError extends Error {}

// ---- File IO ----

async function readHookDoc(file: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // An empty file is a fresh one, not a broken one — several of these get
  // created by `touch`.
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HookWriteError(`${file} is not valid JSON - fix or move it first, then install again`);
  }
  if (!isRecord(parsed)) {
    throw new HookWriteError(`${file} does not hold a JSON object`);
  }
  return parsed;
}

// Milliseconds included deliberately: two installs in the same second would
// otherwise share a name, and the second backup would overwrite the first —
// losing the only copy of what the file looked like before core touched it.
function backupName(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  return `${file}.tmux-server-backup-${stamp}`;
}

// Backup beside the file, then write a sibling temp file and rename it over
// the original — a rename within one directory is atomic, so a crash leaves
// either the old file or the new one and never a truncated mix. The original
// file's mode is carried over; a new file gets the process umask's.
async function writeHookDoc(file: string, doc: Record<string, unknown>): Promise<string | null> {
  await mkdir(path.dirname(file), { recursive: true });
  let backup: string | null = null;
  let mode: number | undefined;
  try {
    const info = await stat(file);
    mode = info.mode & 0o777;
    backup = backupName(file);
    await copyFile(file, backup);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const temp = `${file}.tmux-server-tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(doc, null, 2)}\n`);
  if (mode !== undefined) await chmod(temp, mode);
  await rename(temp, file);
  return backup;
}

// ---- State ----

export interface HookState {
  agentId: string;
  // "unsupported" — this agent speaks no hook schema core knows.
  // "not-installed" — nothing of core's is in the file.
  // "installed" — core's entries match what its subscribers currently want.
  // "stale" — core's entries are there but no longer right; `staleReason`
  //   says why in one sentence a user can act on.
  state: "unsupported" | "not-installed" | "installed" | "stale";
  file: string | null;
  ownership: "merged" | "whole-file" | null;
  // Raw event names core has installed, and the ones it would install now.
  installedEvents: string[];
  wantedEvents: string[];
  staleReason: string | null;
  // Set when the file itself could not be read as JSON: nothing was written
  // and nothing will be until it is fixed.
  error: string | null;
  // An old agent-monitor snippet is still in this file. Independent of
  // `state` — it is the user's own pasted hook, and all core can do is say
  // it stopped working.
  legacyMonitorHook: boolean;
}

// `wantedEvents` comes from the caller (agentHooks.ts owns the subscriber
// union) rather than being read here, so this module stays free of the
// pipeline and the two never import each other.
export async function hookStateFor(agent: AgentPreset, events: readonly AgentEvent[]): Promise<HookState> {
  const base = {
    agentId: agent.id,
    installedEvents: [] as string[],
    wantedEvents: [] as string[],
    staleReason: null,
    error: null,
    legacyMonitorHook: false,
  };
  if (!agent.hooks) {
    return { ...base, state: "unsupported", file: null, ownership: null };
  }
  const file = hookFileFor(agent.hooks);
  const snippet = snippetFor(agent, events);
  const wantedEvents = rawEventsFor(agent.hooks, events);
  const ownership = snippet?.ownership ?? (agent.hooks === "codex" ? "whole-file" : "merged");

  let doc: Record<string, unknown> | null;
  try {
    doc = await readHookDoc(file);
  } catch (err) {
    return {
      ...base,
      state: "not-installed",
      file,
      ownership,
      wantedEvents,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const scan =
    doc === null
      ? { coreEvents: [], coreAgentIds: [], legacyFound: false }
      : agent.hooks === "agy"
        ? scanAgy(doc)
        : scanNested(isRecord(doc.hooks) ? doc.hooks : {});

  const result: HookState = {
    ...base,
    state: scan.coreEvents.length === 0 ? "not-installed" : "installed",
    file,
    ownership,
    installedEvents: scan.coreEvents,
    wantedEvents,
    legacyMonitorHook: scan.legacyFound,
  };
  if (result.state === "not-installed") return result;

  const installed = scan.coreEvents.join(",");
  if (installed !== wantedEvents.join(",")) {
    result.state = "stale";
    result.staleReason =
      wantedEvents.length === 0
        ? "Nothing is subscribed to agent hooks any more, so these can be removed."
        : "The installed events no longer match what the enabled extensions ask for. Install again to update them.";
    return result;
  }
  // The hooks are per config file, so two presets sharing a CLI share one
  // installed entry; what must still hold is that the agent it names exists,
  // or its events arrive for an agent core can no longer resolve.
  const agents = await resolveAgents();
  const orphan = scan.coreAgentIds.find((id) => !agents.some((a) => a.id === id));
  if (orphan !== undefined) {
    result.state = "stale";
    result.staleReason = `These hooks report as "${orphan}", which is not in the list any more. Install again to point them at this agent.`;
  }
  return result;
}

// ---- Install / uninstall ----

export interface HookWriteResult {
  state: HookState;
  // Where the previous contents were kept, when there were any.
  backup: string | null;
}

export async function installHooks(agent: AgentPreset, events: readonly AgentEvent[]): Promise<HookWriteResult> {
  if (!agent.hooks) throw new HookWriteError(`${agent.label} has no hook format core can write`);
  if (!isSafeAgentId(agent.id)) throw new HookWriteError(`"${agent.id}" is not a usable agent id`);
  const rawEvents = rawEventsFor(agent.hooks, events);
  if (rawEvents.length === 0) {
    throw new HookWriteError(
      "Nothing is subscribed to agent hooks yet, so there is nothing to install. Enable an extension that uses them first.",
    );
  }
  const file = hookFileFor(agent.hooks);
  const doc = (await readHookDoc(file)) ?? {};

  if (agent.hooks === "agy") {
    // Core owns one named wrapper. Any wrapper that is core's (by command)
    // is dropped first, so a rename or an old event set leaves nothing
    // behind, and a name collision with someone else's wrapper is refused
    // rather than resolved by overwriting it.
    for (const [name, wrapper] of Object.entries(doc)) {
      if (isCoreAgyWrapper(wrapper)) delete doc[name];
    }
    if (doc[AGY_HOOK_NAME] !== undefined) {
      throw new HookWriteError(
        `${file} already has a hook named "${AGY_HOOK_NAME}" that is not core's - rename it and install again`,
      );
    }
    const wrapper: Record<string, unknown> = { enabled: true };
    for (const raw of rawEvents) {
      wrapper[raw] = [{ type: "command", command: hookCommandFor(agent.id, raw), timeout: HOOK_TIMEOUT_SECONDS }];
    }
    doc[AGY_HOOK_NAME] = wrapper;
  } else {
    const hooks = isRecord(doc.hooks) ? { ...doc.hooks } : {};
    stripNestedCoreEntries(hooks);
    for (const raw of rawEvents) {
      const existing = Array.isArray(hooks[raw]) ? (hooks[raw] as unknown[]) : [];
      hooks[raw] = [...existing, nestedEntryFor(agent.hooks, agent.id, raw)];
    }
    doc.hooks = hooks;
    // Codex's file is core's own, and the key is required by its parser.
    if (agent.hooks === "codex" && typeof doc.description !== "string") {
      doc.description = "tmux-server agent hooks";
    }
  }

  const backup = await writeHookDoc(file, doc);
  return { state: await hookStateFor(agent, events), backup };
}

export async function uninstallHooks(agent: AgentPreset, events: readonly AgentEvent[]): Promise<HookWriteResult> {
  if (!agent.hooks) throw new HookWriteError(`${agent.label} has no hook format core can write`);
  const file = hookFileFor(agent.hooks);
  const doc = await readHookDoc(file);
  if (doc === null) return { state: await hookStateFor(agent, events), backup: null };

  if (agent.hooks === "agy") {
    for (const [name, wrapper] of Object.entries(doc)) {
      if (isCoreAgyWrapper(wrapper)) delete doc[name];
    }
  } else if (isRecord(doc.hooks)) {
    const hooks = { ...doc.hooks };
    stripNestedCoreEntries(hooks);
    // An emptied hooks key is left as an empty object rather than deleted:
    // it was there before core wrote anything, and removing a key the user
    // may have put there is not core's call.
    doc.hooks = hooks;
  }

  const backup = await writeHookDoc(file, doc);
  return { state: await hookStateFor(agent, events), backup };
}

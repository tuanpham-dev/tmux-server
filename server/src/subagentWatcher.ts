import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Reads Claude Code's own on-disk subagent sidecars — no CLI spawned, no
// process introspection, just the JSONL/meta.json files it already writes
// (plans/subagent-activity-viewer.md). Format verified against ~300 real
// sidecar files on this machine, not assumed from docs (none exist):
//
//   ~/.claude/projects/<cwd, / and . replaced with «-»>/<sessionId>.jsonl
//   ~/.claude/projects/<same>/<sessionId>/subagents/agent-<agentId>.meta.json
//   ~/.claude/projects/<same>/<sessionId>/subagents/agent-<agentId>.jsonl
//
// meta.json: {agentType, description, toolUseId, spawnDepth, parentAgentId?}
// — a stable schema across every sample seen. The paired .jsonl is the
// subagent's own message transcript, same line shape as a top-level
// session's own .jsonl (each line: {type, message, timestamp, ...}).
//
// This module never writes anything and treats every read as best-effort:
// a missing/malformed file just contributes nothing, per this plan's
// Constraints ("degrade to 'no agents' on any error, never break the
// sessions poll").

const CLAUDE_PROJECTS_DIR = path.join(homedir(), ".claude", "projects");

// A subagent's .jsonl keeps growing while it's genuinely working — no
// explicit "done" field exists in the format, so recency of the last write
// is the only available "is this still running" signal. 15s is a few
// multiples of the 3s sessions-poll cadence: long enough that a normal
// thinking/tool-call gap doesn't read as "finished", short enough that a
// truly finished agent flips within one or two poll beats.
const ACTIVE_THRESHOLD_MS = 15_000;

function cwdToProjectDirName(cwd: string): string {
  // Claude Code's own convention, confirmed against real directories: every
  // "/" and "." in the absolute path becomes "-" (nothing else does — a
  // literal "-" already in the path, e.g. from "tmux-server", passes
  // through unchanged). Must be given the real absolute cwd, not a
  // tilde-shortened display path (tmux.ts's shortenHome output would
  // resolve to the wrong directory).
  return cwd.replace(/[/.]/g, "-");
}

interface AgentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  parentAgentId?: string;
}

function isAgentMeta(value: unknown): value is AgentMeta {
  return typeof value === "object" && value !== null;
}

// The most recently active session directory for a project — the flat
// <sessionId>.jsonl siblings (not the <sessionId>/ subdirectories) are what
// a live session keeps appending to, so their mtime is the most direct
// "which session is actually live right now" signal for this cwd.
async function mostRecentSessionId(projectDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }
  const jsonlNames = entries.filter((e) => e.endsWith(".jsonl") && !e.includes("/"));
  let best: { id: string; mtimeMs: number } | null = null;
  for (const name of jsonlNames) {
    try {
      const s = await stat(path.join(projectDir, name));
      const id = name.slice(0, -".jsonl".length);
      if (!best || s.mtimeMs > best.mtimeMs) best = { id, mtimeMs: s.mtimeMs };
    } catch {
      // Skip — a file that vanished mid-scan just isn't a candidate.
    }
  }
  return best?.id ?? null;
}

// A claude window's cwd rarely switches which session is "most recent" —
// that only happens when a new session starts in the same cwd — yet the raw
// lookup above stats every historical *.jsonl sibling in the project dir
// (which accumulates across a project's whole lifetime) on every 2s cache
// miss from getCounts below. Cache the resolved id per project dir; a new
// session in the same cwd is picked up within one TTL window.
const SESSION_ID_TTL_MS = 15_000;
const sessionIdCache = new Map<string, { at: number; id: string | null }>();

async function mostRecentSessionIdCached(projectDir: string): Promise<string | null> {
  const cached = sessionIdCache.get(projectDir);
  if (cached && Date.now() - cached.at < SESSION_ID_TTL_MS) return cached.id;
  const id = await mostRecentSessionId(projectDir);
  sessionIdCache.set(projectDir, { at: Date.now(), id });
  return id;
}

interface SubagentFile {
  agentId: string;
  metaPath: string;
  jsonlPath: string;
}

async function listSubagentFiles(projectDir: string, sessionId: string): Promise<SubagentFile[]> {
  const subagentsDir = path.join(projectDir, sessionId, "subagents");
  let entries: string[];
  try {
    entries = await readdir(subagentsDir);
  } catch {
    return [];
  }
  const files: SubagentFile[] = [];
  for (const name of entries) {
    if (!name.endsWith(".meta.json")) continue;
    const agentId = name.slice("agent-".length, -".meta.json".length);
    files.push({
      agentId,
      metaPath: path.join(subagentsDir, name),
      jsonlPath: path.join(subagentsDir, `agent-${agentId}.jsonl`),
    });
  }
  return files;
}

async function readMeta(metaPath: string): Promise<AgentMeta | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(metaPath, "utf8"));
    return isAgentMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Cheap per-cwd result for the sessions poll: just how many of this cwd's
// most-recent session's subagents currently look active (see
// ACTIVE_THRESHOLD_MS) — no jsonl content is parsed, only meta.json (for
// the count) and jsonl mtimes (for the active check).
async function countRunningAgents(cwd: string): Promise<number> {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, cwdToProjectDirName(cwd));
  const sessionId = await mostRecentSessionIdCached(projectDir);
  if (!sessionId) return 0;
  const files = await listSubagentFiles(projectDir, sessionId);
  if (files.length === 0) return 0;
  const now = Date.now();
  let running = 0;
  await Promise.all(
    files.map(async (f) => {
      try {
        const s = await stat(f.jsonlPath);
        if (now - s.mtimeMs < ACTIVE_THRESHOLD_MS) running++;
      } catch {
        // A meta.json with no paired jsonl yet (agent just spawned) —
        // not counted as running until it actually writes something.
      }
    }),
  );
  return running;
}

const COUNTS_CACHE_TTL_MS = 2_000;
const countsCache = new Map<string, { at: number; value: number }>();

// Batched for the sessions poll (server/src/tmux.ts's querySessions) — one
// entry per cwd whose window is a claude pane, cheap enough to run on every
// poll thanks to the per-cwd TTL cache above. Cwds with zero running agents
// are omitted from the result (absence means zero, same as the client's
// `agents ?? 0` read).
export async function getCounts(cwds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  await Promise.all(
    cwds.map(async (cwd) => {
      const cached = countsCache.get(cwd);
      const now = Date.now();
      let count: number;
      if (cached && now - cached.at < COUNTS_CACHE_TTL_MS) {
        count = cached.value;
      } else {
        try {
          count = await countRunningAgents(cwd);
        } catch {
          count = 0;
        }
        countsCache.set(cwd, { at: now, value: count });
      }
      if (count > 0) result.set(cwd, count);
    }),
  );
  return result;
}

export type AgentStatus = "running" | "completed";

export interface AgentSummary {
  agentId: string;
  agentType: string;
  description: string;
  model: string | null;
  status: AgentStatus;
  // Output + (non-cached) input tokens summed across every assistant
  // message in this agent's transcript — cache_read/cache_creation tokens
  // are excluded since they don't reflect new generation, just how much of
  // the prompt was already-cached context.
  tokens: number;
  toolCalls: number;
  lastActivityAt: string | null;
}

interface AssistantMessage {
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  content?: Array<{ type?: string }>;
}

function parseJsonlLines(text: string): unknown[] {
  const lines: unknown[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {
      // Skip a malformed/truncated line (e.g. read mid-write) rather than
      // failing the whole agent's summary over one bad line.
    }
  }
  return lines;
}

async function summarizeAgent(file: SubagentFile): Promise<AgentSummary | null> {
  const meta = await readMeta(file.metaPath);
  if (!meta) return null;

  let model: string | null = null;
  let tokens = 0;
  let toolCalls = 0;
  let lastActivityAt: string | null = null;
  let mtimeMs = 0;

  try {
    const [text, s] = await Promise.all([readFile(file.jsonlPath, "utf8"), stat(file.jsonlPath)]);
    mtimeMs = s.mtimeMs;
    for (const raw of parseJsonlLines(text)) {
      if (typeof raw !== "object" || raw === null) continue;
      const line = raw as { type?: string; message?: AssistantMessage; timestamp?: string };
      if (typeof line.timestamp === "string") lastActivityAt = line.timestamp;
      if (line.type !== "assistant" || !line.message) continue;
      if (typeof line.message.model === "string") model = line.message.model;
      const usage = line.message.usage;
      if (usage) tokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      for (const block of line.message.content ?? []) {
        if (block?.type === "tool_use") toolCalls++;
      }
    }
  } catch {
    // No jsonl yet (agent just spawned) — meta.json alone still describes
    // it, just with zeroed stats.
  }

  const status: AgentStatus = Date.now() - mtimeMs < ACTIVE_THRESHOLD_MS ? "running" : "completed";

  return {
    agentId: file.agentId,
    agentType: meta.agentType ?? "general-purpose",
    description: meta.description ?? "",
    model,
    status,
    tokens,
    toolCalls,
    lastActivityAt,
  };
}

// Full detail for the on-demand panel (GET /api/subagents?cwd=) — parses
// each agent's whole transcript, unlike the cheap getCounts() above. Only
// called while the panel is open, not on every sessions poll.
export async function getSubagentDetails(cwd: string): Promise<AgentSummary[]> {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, cwdToProjectDirName(cwd));
  const sessionId = await mostRecentSessionIdCached(projectDir);
  if (!sessionId) return [];
  const files = await listSubagentFiles(projectDir, sessionId);
  const summaries = await Promise.all(files.map(summarizeAgent));
  return summaries.filter((s): s is AgentSummary => s !== null);
}

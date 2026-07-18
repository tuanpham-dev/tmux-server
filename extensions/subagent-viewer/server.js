// subagent-viewer server hook: reads Claude Code's own on-disk subagent
// sidecars — no CLI spawned, no process introspection, just the JSONL/meta
// files it already writes (ported from core server/src/subagentWatcher.ts,
// see plans/subagent-activity-viewer.md). Format verified against ~300 real
// sidecar files:
//
//   ~/.claude/projects/<cwd, / and . replaced with «-»>/<sessionId>.jsonl
//   ~/.claude/projects/<same>/<sessionId>/subagents/agent-<agentId>.meta.json
//   ~/.claude/projects/<same>/<sessionId>/subagents/agent-<agentId>.jsonl
//
// This module never writes anything and treats every read as best-effort: a
// missing/malformed file just contributes nothing.
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const CLAUDE_PROJECTS_DIR = path.join(homedir(), ".claude", "projects");

// A subagent's .jsonl keeps growing while it's genuinely working — no
// explicit "done" field exists in the format, so recency of the last write
// is the only available "is this still running" signal. 15s is a few
// multiples of the client's 3s poll cadence: long enough that a normal
// thinking/tool-call gap doesn't read as "finished", short enough that a
// truly finished agent flips within one or two poll beats.
const ACTIVE_THRESHOLD_MS = 15_000;

// Window cwds arrive in the client's display form, which may be
// "~"-shortened (core tmux.ts's shortenHome) — Claude Code's project-dir
// naming is keyed off the real absolute path.
function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

function cwdToProjectDirName(cwd) {
  // Claude Code's own convention, confirmed against real directories: every
  // "/" and "." in the absolute path becomes "-" (nothing else does).
  return cwd.replace(/[/.]/g, "-");
}

// The most recently active session directory for a project — the flat
// <sessionId>.jsonl siblings (not the <sessionId>/ subdirectories) are what
// a live session keeps appending to, so their mtime is the most direct
// "which session is actually live right now" signal for this cwd.
async function mostRecentSessionId(projectDir) {
  let entries;
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }
  const jsonlNames = entries.filter((e) => e.endsWith(".jsonl") && !e.includes("/"));
  let best = null;
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

// The raw lookup above stats every historical *.jsonl sibling on every
// cache miss — cache the resolved id per project dir; a new session in the
// same cwd is picked up within one TTL window.
const SESSION_ID_TTL_MS = 15_000;
const sessionIdCache = new Map();

async function mostRecentSessionIdCached(projectDir) {
  const cached = sessionIdCache.get(projectDir);
  if (cached && Date.now() - cached.at < SESSION_ID_TTL_MS) return cached.id;
  const id = await mostRecentSessionId(projectDir);
  sessionIdCache.set(projectDir, { at: Date.now(), id });
  return id;
}

async function listSubagentFiles(projectDir, sessionId) {
  const subagentsDir = path.join(projectDir, sessionId, "subagents");
  let entries;
  try {
    entries = await readdir(subagentsDir);
  } catch {
    return [];
  }
  const files = [];
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

async function readMeta(metaPath) {
  try {
    const parsed = JSON.parse(await readFile(metaPath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

// Cheap per-cwd result for the counts poll: just how many of this cwd's
// most-recent session's subagents currently look active — no jsonl content
// is parsed, only meta.json (for the count) and jsonl mtimes (for the
// active check).
async function countRunningAgents(cwd) {
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
const countsCache = new Map();

// Batched for the client's 3s poll — one entry per claude-window cwd, cheap
// enough thanks to the per-cwd TTL cache. Cwds with zero running agents are
// omitted (absence means zero).
async function getCounts(cwds) {
  const result = {};
  await Promise.all(
    cwds.map(async (cwd) => {
      const key = expandHome(cwd);
      const cached = countsCache.get(key);
      const now = Date.now();
      let count;
      if (cached && now - cached.at < COUNTS_CACHE_TTL_MS) {
        count = cached.value;
      } else {
        try {
          count = await countRunningAgents(key);
        } catch {
          count = 0;
        }
        countsCache.set(key, { at: now, value: count });
      }
      // Keyed by the cwd string exactly as the client sent it, so the
      // client maps straight back to its window rows.
      if (count > 0) result[cwd] = count;
    }),
  );
  return result;
}

function parseJsonlLines(text) {
  const lines = [];
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

async function summarizeAgent(file) {
  const meta = await readMeta(file.metaPath);
  if (!meta) return null;

  let model = null;
  let tokens = 0;
  let toolCalls = 0;
  let lastActivityAt = null;
  let mtimeMs = 0;

  try {
    const [text, s] = await Promise.all([readFile(file.jsonlPath, "utf8"), stat(file.jsonlPath)]);
    mtimeMs = s.mtimeMs;
    for (const raw of parseJsonlLines(text)) {
      if (typeof raw !== "object" || raw === null) continue;
      if (typeof raw.timestamp === "string") lastActivityAt = raw.timestamp;
      if (raw.type !== "assistant" || !raw.message) continue;
      if (typeof raw.message.model === "string") model = raw.message.model;
      const usage = raw.message.usage;
      // Output + (non-cached) input tokens only — cache_read/cache_creation
      // don't reflect new generation, just already-cached context.
      if (usage) tokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      for (const block of raw.message.content ?? []) {
        if (block?.type === "tool_use") toolCalls++;
      }
    }
  } catch {
    // No jsonl yet (agent just spawned) — meta.json alone still describes
    // it, just with zeroed stats.
  }

  const status = Date.now() - mtimeMs < ACTIVE_THRESHOLD_MS ? "running" : "completed";

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

// Full detail for the on-demand popover — parses each agent's whole
// transcript, unlike the cheap getCounts above. Only called while the
// popover is open, not on every counts poll.
async function getSubagentDetails(cwd) {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, cwdToProjectDirName(expandHome(cwd)));
  const sessionId = await mostRecentSessionIdCached(projectDir);
  if (!sessionId) return [];
  const files = await listSubagentFiles(projectDir, sessionId);
  const summaries = await Promise.all(files.map(summarizeAgent));
  return summaries.filter((s) => s !== null);
}

export function activate({ router }) {
  router.post("/counts", async (req, res) => {
    const cwds = Array.isArray(req.body?.cwds)
      ? req.body.cwds.filter((c) => typeof c === "string")
      : [];
    try {
      res.json({ counts: await getCounts(cwds) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/details", async (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    if (!cwd) {
      res.status(400).json({ error: "cwd is required" });
      return;
    }
    try {
      res.json(await getSubagentDetails(cwd));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

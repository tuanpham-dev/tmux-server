// Tests for agentTarget.ts's pure resolution logic — the shared "what is an
// agent" helper that git-scm, live-preview and ports all route through, and
// that the github and jira extensions vendor byte-identical copies of
// (plans/agent-platform-core.md).
//
// Plain `node --test`, same as statusModel.test.mjs beside it. It imports the
// .ts source directly: Node strips types natively, so no tsx and no build
// step is involved — which also means these run against the exact file the
// bundles inline, not a copy.
//
// `fetch` is stubbed per test rather than mocked at module level, because
// what is being pinned down is the THREE-WAY choice every caller makes: the
// deprecated per-extension setting, the core registry, or the pre-registry
// floor when the registry cannot be read at all.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWindows, launchCommand, resolveAgentPresets, resolveAgentTargets } from "./agentTarget.ts";

// ---- Fixtures ----

const REGISTRY = [
  {
    id: "claude",
    label: "Claude Code",
    program: "claude",
    command: "claude",
    skipPermissionsArgs: "--dangerously-skip-permissions",
    hooks: "claude",
  },
  // Detection-only: no launch command, so it is never offered as a preset.
  { id: "watcher", label: "Watcher", program: "watcher", command: "", skipPermissionsArgs: "", hooks: null },
  // Launch-only: no foreground command, so it can never match a pane.
  { id: "wrapper", label: "Wrapper", program: "", command: "run-agent", skipPermissionsArgs: "", hooks: null },
];

const SESSIONS = [
  {
    name: "repo",
    path: "~/proj",
    windows: [
      { index: 0, name: "zsh", command: "zsh" },
      { index: 1, name: "agent", command: "claude" },
      { index: 2, name: "other", command: "codex" },
    ],
  },
  { name: "elsewhere", path: "~/other", windows: [{ index: 0, name: "a", command: "claude" }] },
  // Synthetic per-window session: mirrors a real session's windows, so
  // counting it would double-list every match.
  { name: "tmuxserver-view-abc", path: "~/proj", windows: [{ index: 0, name: "m", command: "claude" }] },
];

function serveRegistry() {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ agents: REGISTRY }) });
}

// What an older core does: /api/agents does not exist there at all.
function serveNothing() {
  globalThis.fetch = async () => ({ ok: false, status: 404, statusText: "Not Found" });
}

function found(agents, repoPath = "~/proj") {
  return agentWindows(SESSIONS, repoPath, agents).map((w) => `${w.sessionName}:${w.windowIndex}`);
}

// ---- Detection ----

test("matches panes against the registry's programs, once each", async () => {
  serveRegistry();
  assert.deepEqual(found(await resolveAgentTargets(undefined)), ["repo:1"]);
});

test("a launch-only entry with no program matches nothing", () => {
  const blankCommandPane = [{ name: "s", path: "~/proj", windows: [{ index: 0, name: "w", command: "" }] }];
  assert.deepEqual(agentWindows(blankCommandPane, "~/proj", [{ program: "" }]), []);
});

test("only sessions at or under the repo path count", async () => {
  serveRegistry();
  const agents = await resolveAgentTargets(undefined);
  assert.deepEqual(found(agents, "~/other"), ["elsewhere:0"]);
  assert.deepEqual(found(agents, "~/nowhere"), []);
});

test("a stored deprecated programs setting wins, and the registry is not even fetched", async () => {
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return { ok: true, json: async () => ({ agents: REGISTRY }) };
  };
  const agents = await resolveAgentTargets(" codex , zsh ");
  assert.equal(fetched, false);
  assert.deepEqual(found(agents), ["repo:0", "repo:2"]);
});

test("an empty or non-string programs setting falls through to the registry", async () => {
  serveRegistry();
  for (const legacy of ["", "   ", undefined, null, 42]) {
    assert.deepEqual(await resolveAgentTargets(legacy), REGISTRY, `legacy=${String(legacy)}`);
  }
});

// ---- Launch presets ----

test("offers the registry's launchable entries, in order, skipping detection-only ones", async () => {
  serveRegistry();
  assert.deepEqual(await resolveAgentPresets(undefined), [
    { name: "Claude Code", command: "claude", skipPermissionsArgs: "--dangerously-skip-permissions" },
    { name: "Wrapper", command: "run-agent", skipPermissionsArgs: "" },
  ]);
});

test("a stored deprecated agents JSON wins over the registry", async () => {
  serveRegistry();
  const legacy = JSON.stringify([{ name: "My Agent", command: "my-agent --go" }]);
  // The old JSON shape had no skip field, so entries parsed from it get none.
  assert.deepEqual(await resolveAgentPresets(legacy), [
    { name: "My Agent", command: "my-agent --go", skipPermissionsArgs: "" },
  ]);
});

test('a stored "[]" means offer nothing, and the registry does not override it', async () => {
  serveRegistry();
  assert.deepEqual(await resolveAgentPresets("[]"), []);
});

test("a hand-broken agents value falls through to the registry rather than offering nothing", async () => {
  serveRegistry();
  assert.equal((await resolveAgentPresets("{not json")).length, 2);
});

// ---- Version skew: installed on a core with no registry ----
// These extensions ship from a separate registry repo and can land on any
// core version, and there is no manifest field for a minimum one. A 404 must
// degrade to what each extension shipped with before the registry existed,
// never reject: rejecting takes the feature out entirely.

test("detection degrades to the pre-registry default when the registry cannot be read", async () => {
  serveNothing();
  const agents = await resolveAgentTargets("");
  assert.deepEqual(agents, [{ program: "claude" }]);
  assert.deepEqual(found(agents), ["repo:1"]);
});

test("presets degrade to the pre-registry pair when the registry cannot be read", async () => {
  serveNothing();
  assert.deepEqual(await resolveAgentPresets(""), [
    { name: "Claude Code", command: "claude", skipPermissionsArgs: "--dangerously-skip-permissions" },
  ]);
});

test("a stored setting still wins over the fallback on a core with no registry", async () => {
  serveNothing();
  assert.deepEqual(await resolveAgentTargets("codex"), [{ program: "codex" }]);
  assert.deepEqual(await resolveAgentPresets("[]"), []);
});

// ---- Skip-permissions flag ----

test("launchCommand appends the flag only when asked and only when there is one", () => {
  const claude = { name: "Claude Code", command: "claude", skipPermissionsArgs: "--dangerously-skip-permissions" };
  const plain = { name: "Wrapper", command: "run-agent", skipPermissionsArgs: "" };
  assert.equal(launchCommand(claude, false), "claude");
  assert.equal(launchCommand(claude, true), "claude --dangerously-skip-permissions");
  // Nothing to append: the caller should not be offering the choice at all,
  // but asking for it must never mangle the command.
  assert.equal(launchCommand(plain, true), "run-agent");
});

test("each agent keeps its own flag rather than a shared one", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      agents: [
        { id: "claude", label: "Claude Code", program: "claude", command: "claude", skipPermissionsArgs: "--dangerously-skip-permissions", hooks: "claude" },
        { id: "codex", label: "OpenAI Codex", program: "codex", command: "codex", skipPermissionsArgs: "--dangerously-bypass-approvals-and-sandbox", hooks: "codex" },
      ],
    }),
  });
  const presets = await resolveAgentPresets(undefined);
  assert.equal(launchCommand(presets[0], true), "claude --dangerously-skip-permissions");
  assert.equal(launchCommand(presets[1], true), "codex --dangerously-bypass-approvals-and-sandbox");
});

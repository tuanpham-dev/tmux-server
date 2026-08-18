// worktrees: the WORKTREES accordion section — git worktrees of the active
// repo, each openable as its own tmux session. The point is parallel work on
// one repo (notably several agents at once) without branch collisions: one
// checkout + one session per branch.
//
// Host hooks arrive via module-level bridge variables set once in activate() —
// same pattern as the ports, search, and git-scm extensions.
//
// Session lifecycle is entirely the host's: openSessionWindow creates/opens,
// killSession kills (and closes the window-tabs a raw tmux kill would orphan).
// This extension's server hook only ever touches git.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";
import type { MenuItem } from "../../_shared/types";
import { useLongPressMenu } from "../../_shared/useLongPressMenu";
import { sendToAgent } from "../../_shared/agentTarget";

// ---- Module-level host bridge ----

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let getActiveContext: (() => ActiveContext) | null = null;
let onDidChangeContext: ((cb: (ctx: ActiveContext) => void) => () => void) | null = null;
let openSessionWindow: ((sessionName: string, opts?: { createCwd?: string }) => void) | null = null;
let killSessionInHost: ((sessionName: string) => void) | null = null;
let revealSidebarPanel: ((panelId: string) => void) | null = null;
let removeStylesheet: (() => void) | null = null;
let extSettings: SettingsApi | null = null;

// Set by the "New Worktree Session…"/"New Agent Session…" commands and
// consumed by the panel on its next render — the commands reveal the panel,
// the panel opens its form. Module-level rather than a prop because the
// commands run outside React. agentIndex is which preset (see AGENT_PRESETS
// below) the form preselects; null leaves it at "None".
let pendingCreate = false;
let pendingCreateAgentIndex: number | null = null;
const pendingCreateListeners = new Set<() => void>();

function requestCreateForm(agentIndex: number | null = null) {
  pendingCreate = true;
  pendingCreateAgentIndex = agentIndex;
  for (const cb of pendingCreateListeners) cb();
}

// ---- Types (mirror server.js's responses) ----

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

interface AgentPreset {
  name: string;
  command: string;
}

// worktrees.agents is a JSON-string setting (the documented pattern for
// richer-than-scalar configuration) — malformed JSON or a non-array/missing
// setting just means no presets, not an error.
function parseAgentPresets(raw: unknown): AgentPreset[] {
  if (typeof raw !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (p): p is AgentPreset =>
      typeof p === "object" && p !== null && typeof (p as AgentPreset).name === "string" && typeof (p as AgentPreset).command === "string",
  );
}

interface Worktree {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  main: boolean;
  dirty: boolean;
  session: string | null;
}

interface Branch {
  name: string;
  checkedOutAt: string | null;
}

interface ListResponse {
  repo: string | null;
  worktrees: Worktree[];
  branches: Branch[];
}

// ---- Fetch helpers ----

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status message
    }
    throw new Error(message);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function fetchList(cwd: string): Promise<ListResponse> {
  if (!serverFetch) return Promise.reject(new Error("extension not activated"));
  return serverFetch(`/list?cwd=${encodeURIComponent(cwd)}`).then((res) => readJson<ListResponse>(res));
}

function createWorktree(body: {
  cwd: string;
  branch: string;
  base?: string;
  mode: "new" | "existing";
}): Promise<{ path: string; branch: string }> {
  if (!serverFetch) return Promise.reject(new Error("extension not activated"));
  return serverFetch("/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((res) => readJson<{ path: string; branch: string }>(res));
}

function removeWorktree(body: { cwd: string; path: string; force?: boolean }): Promise<void> {
  if (!serverFetch) return Promise.reject(new Error("extension not activated"));
  return serverFetch("/remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((res) => readJson<void>(res));
}

// ---- Helpers ----

const POLL_MS = 5000;

// tmux session names can't contain "." or ":" (tmux's own target syntax) and
// whitespace makes them awkward to type; "/" would also read as a path.
// Mirrored byte-for-byte in server.js, which compares live session names
// against it to decide which session a worktree row belongs to.
function sessionNameFor(branch: string): string {
  return branch.replace(/[.:/\s]+/g, "-").replace(/^-+|-+$/g, "");
}

function worktreeLabel(wt: Worktree): string {
  if (wt.branch) return wt.branch;
  if (wt.detached) return `(detached ${wt.head?.slice(0, 7) ?? "?"})`;
  return wt.path.split("/").pop() ?? wt.path;
}

// git refuses to check a branch out in two worktrees at once, so the create
// form's "existing branch" mode only offers the unattached ones.
function availableBranches(branches: Branch[]): Branch[] {
  return branches.filter((b) => !b.checkedOutAt);
}

interface PanelProps {
  actionsTarget?: HTMLDivElement | null;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  confirmDialog?: (message: string, confirmLabel?: string) => Promise<boolean>;
}

function WorktreesPanel({ actionsTarget, showMenu, confirmDialog }: PanelProps) {
  const bindMenu = useLongPressMenu();
  const [cwd, setCwd] = useState<string | null>(() => getActiveContext?.().cwd ?? null);
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [sessionName, setSessionName] = useState("");
  // Whether the user has typed their own session name — until then it tracks
  // the branch field, so the common case needs no second edit.
  const sessionEditedRef = useRef(false);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const [agentPresets, setAgentPresets] = useState<AgentPreset[]>(() =>
    parseAgentPresets(extSettings?.get("worktrees.agents")),
  );
  // "" = None; otherwise an index into agentPresets. Persists across opens
  // (module-level would survive unmount too, but per-mount is enough here —
  // reopening the panel losing the last pick is an acceptable reset).
  const [agentChoice, setAgentChoice] = useState<string>("");

  useEffect(
    () => extSettings?.onDidChange(() => setAgentPresets(parseAgentPresets(extSettings?.get("worktrees.agents")))),
    [],
  );

  useEffect(() => {
    if (!onDidChangeContext) return;
    return onDidChangeContext((ctx) => setCwd(ctx.cwd));
  }, []);

  const refresh = useCallback(() => {
    if (!cwd) {
      setData(null);
      return;
    }
    fetchList(cwd)
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, [cwd]);

  // Poll while mounted so a session started/ended elsewhere (or a worktree
  // created from a terminal) shows up without a manual refresh — same cadence
  // and lifecycle as the ports/git-scm panels.
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Base is left empty rather than prefilled with the current branch: git's own
  // default for `worktree add -b` is exactly that, the placeholder says so, and
  // prefilling would depend on the listing having loaded — which it hasn't when
  // the palette command opens this form on a fresh panel.
  const openForm = useCallback((presetIndex: number | null = null) => {
    setFormOpen(true);
    sessionEditedRef.current = false;
    setBranch("");
    setSessionName("");
    setBase("");
    setAgentChoice(presetIndex === null ? "" : String(presetIndex));
    // The input mounts with the form; focus after paint.
    window.setTimeout(() => branchInputRef.current?.focus(), 0);
  }, []);

  // The palette command's half of the handoff: it reveals this panel and sets
  // pendingCreate, which this consumes once the panel is actually mounted.
  useEffect(() => {
    const consume = () => {
      if (!pendingCreate) return;
      pendingCreate = false;
      openForm(pendingCreateAgentIndex);
      pendingCreateAgentIndex = null;
    };
    pendingCreateListeners.add(consume);
    consume();
    return () => {
      pendingCreateListeners.delete(consume);
    };
  }, [openForm]);

  const submit = useCallback(async () => {
    const trimmed = branch.trim();
    if (!cwd || !trimmed || busy) return;
    const name = (sessionName.trim() || sessionNameFor(trimmed)).trim();
    setBusy(true);
    try {
      const created = await createWorktree({
        cwd,
        branch: trimmed,
        base: mode === "new" ? base.trim() || undefined : undefined,
        mode,
      });
      setFormOpen(false);
      setError(null);
      // Host-owned: creates the session rooted in the new worktree (it isn't
      // running yet, so createCwd is what makes this work) and opens it.
      openSessionWindow?.(name, { createCwd: created.path });
      const preset = agentChoice !== "" ? agentPresets[Number(agentChoice)] : undefined;
      if (preset) {
        // Not awaited — the session UI shouldn't stay busy for the retry
        // window; a still-failing send surfaces via the panel's own error
        // banner instead of blocking the create flow. Retries on 404 since
        // the session doesn't exist yet the instant openSessionWindow
        // returns — it's fire-and-forget on the host side.
        sendToAgent(name, preset.command, true, { retries: 12, retryDelayMs: 400 }).catch((err: Error) => {
          setError(`Worktree created, but couldn't start "${preset.name}": ${err.message}`);
        });
      }
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [branch, base, mode, sessionName, cwd, busy, refresh, agentChoice, agentPresets]);

  const openWorktree = useCallback((wt: Worktree) => {
    if (wt.session) {
      openSessionWindow?.(wt.session);
      return;
    }
    const name = sessionNameFor(worktreeLabel(wt));
    openSessionWindow?.(name, { createCwd: wt.path });
  }, []);

  const confirm = useMemo(
    () => confirmDialog ?? ((message: string) => Promise.resolve(window.confirm(message))),
    [confirmDialog],
  );

  const remove = useCallback(
    async (wt: Worktree, alsoKillSession: boolean) => {
      if (!cwd) return;
      const label = worktreeLabel(wt);
      const message = alsoKillSession
        ? `Kill tmux session "${wt.session}" and remove the worktree at ${wt.path}?\n\nThe branch "${label}" is kept.`
        : wt.session
          ? `Remove the worktree at ${wt.path}?\n\nSession "${wt.session}" is left running — its shells will be sitting in a deleted directory. The branch "${label}" is kept.`
          : `Remove the worktree at ${wt.path}?\n\nThe branch "${label}" is kept.`;
      if (!(await confirm(message, alsoKillSession ? "Kill & Remove" : "Remove Worktree"))) return;
      if (alsoKillSession && wt.session) killSessionInHost?.(wt.session);
      setBusy(true);
      try {
        await removeWorktree({ cwd, path: wt.path });
        setError(null);
      } catch (err) {
        const message = (err as Error).message;
        // git refuses to drop a worktree with modified/untracked files; that's
        // the one case worth a second, explicit prompt rather than an error.
        if (!/use --force|contains modified or untracked/i.test(message)) {
          setError(message);
          setBusy(false);
          return;
        }
        const forced = await confirm(
          `${wt.path} has uncommitted changes.\n\nRemove it anyway? The changes are discarded and can't be recovered.`,
          "Force Remove",
        );
        if (forced) {
          try {
            await removeWorktree({ cwd, path: wt.path, force: true });
            setError(null);
          } catch (forceErr) {
            setError((forceErr as Error).message);
          }
        }
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [cwd, confirm, refresh],
  );

  const menuItems = useCallback(
    (wt: Worktree): MenuItem[] => {
      const items: MenuItem[] = [
        { label: wt.session ? "Open Session" : "Start Session Here", onClick: () => openWorktree(wt) },
      ];
      if (!wt.main) {
        if (wt.session) {
          items.push({
            label: "Kill Session & Remove Worktree…",
            danger: true,
            onClick: () => void remove(wt, true),
          });
        }
        items.push({ label: "Remove Worktree…", danger: true, onClick: () => void remove(wt, false) });
      }
      return items;
    },
    [openWorktree, remove],
  );

  const worktrees = data?.worktrees ?? [];
  const branchOptions = mode === "existing" ? availableBranches(data?.branches ?? []) : data?.branches ?? [];

  return (
    <div className="worktrees-panel">
      {actionsTarget &&
        createPortal(
          <button
            type="button"
            className="worktrees-action"
            title="New worktree session…"
            aria-label="New worktree session…"
            disabled={!data?.repo}
            onClick={(e) => {
              e.stopPropagation();
              if (formOpen) setFormOpen(false);
              else openForm();
            }}
          >
            <Icon name="add" />
          </button>,
          actionsTarget,
        )}

      {error && <div className="worktrees-error">{error}</div>}

      {!data?.repo && !error && (
        <div className="worktrees-empty">
          {cwd ? "Not a git repository." : "No active window."}
        </div>
      )}

      {formOpen && data?.repo && (
        <form
          className="worktrees-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="worktrees-form-modes">
            <label>
              <input
                type="radio"
                name="worktree-mode"
                checked={mode === "new"}
                onChange={() => setMode("new")}
              />
              New branch
            </label>
            <label>
              <input
                type="radio"
                name="worktree-mode"
                checked={mode === "existing"}
                onChange={() => setMode("existing")}
              />
              Existing
            </label>
          </div>
          <input
            ref={branchInputRef}
            className="worktrees-input"
            list="worktrees-branch-options"
            placeholder={mode === "new" ? "New branch name" : "Branch to check out"}
            value={branch}
            onChange={(e) => {
              setBranch(e.target.value);
              if (!sessionEditedRef.current) setSessionName(sessionNameFor(e.target.value));
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFormOpen(false);
            }}
          />
          <datalist id="worktrees-branch-options">
            {branchOptions.map((b) => (
              <option key={b.name} value={b.name} />
            ))}
          </datalist>
          {mode === "new" && (
            <input
              className="worktrees-input"
              list="worktrees-base-options"
              placeholder="Base (defaults to current branch)"
              value={base}
              onChange={(e) => setBase(e.target.value)}
            />
          )}
          <datalist id="worktrees-base-options">
            {(data?.branches ?? []).map((b) => (
              <option key={b.name} value={b.name} />
            ))}
          </datalist>
          <input
            className="worktrees-input"
            placeholder="Session name"
            value={sessionName}
            onChange={(e) => {
              sessionEditedRef.current = true;
              setSessionName(e.target.value);
            }}
          />
          {agentPresets.length > 0 && (
            <select
              className="worktrees-input"
              aria-label="Start agent"
              value={agentChoice}
              onChange={(e) => setAgentChoice(e.target.value)}
            >
              <option value="">Start agent: None</option>
              {agentPresets.map((preset, i) => (
                <option key={preset.name + i} value={i}>
                  Start agent: {preset.name}
                </option>
              ))}
            </select>
          )}
          <div className="worktrees-form-buttons">
            <button type="submit" disabled={!branch.trim() || busy}>
              Create
            </button>
            <button type="button" onClick={() => setFormOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {data?.repo && (
        <ul className="worktree-list">
          {worktrees.map((wt) => (
            <li key={wt.path}>
              <div
                className="worktree-row"
                role="button"
                tabIndex={0}
                title={wt.path}
                onClick={() => openWorktree(wt)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openWorktree(wt);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  showMenu?.(e.clientX, e.clientY, menuItems(wt));
                }}
                {...bindMenu((x, y) => showMenu?.(x, y, menuItems(wt)))}
              >
                <Icon name={wt.main ? "repo" : "git-branch"} />
                <span className="worktree-name">{worktreeLabel(wt)}</span>
                {wt.dirty && <span className="worktree-dirty" title="Uncommitted changes" />}
                {wt.main && <span className="worktree-tag">main</span>}
                {wt.prunable && <span className="worktree-tag worktree-tag-warn">missing</span>}
                {wt.session && (
                  <span className="worktree-session" title={`tmux session "${wt.session}"`}>
                    {wt.session}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Activation ----

interface ExtensionContext {
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    icon?: string;
    location?: "tab" | "explorer" | "run";
    defaultCollapsed?: boolean;
    order?: number;
    focusBinding?: string;
    component: (props: PanelProps) => ReturnType<typeof WorktreesPanel>;
  }): void;
  registerCommand(command: { id: string; label: string; defaultBinding?: string; run: () => void }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  settings: SettingsApi;
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
    openSessionWindow(sessionName: string, opts?: { createCwd?: string }): void;
    killSession(sessionName: string): void;
    revealSidebarPanel(panelId: string): void;
  };
}

const PANEL_ID = "worktrees";

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  getActiveContext = ctx.app.getActiveContext;
  onDidChangeContext = ctx.app.onDidChangeContext;
  openSessionWindow = ctx.app.openSessionWindow;
  killSessionInHost = ctx.app.killSession;
  revealSidebarPanel = ctx.app.revealSidebarPanel;
  extSettings = ctx.settings;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  ctx.registerSidebarPanel({
    id: PANEL_ID,
    title: "Worktrees",
    icon: "git-branch",
    location: "explorer",
    order: 30,
    // Explorer height is contested by SESSIONS/FILES; this is a "when I need
    // it" panel, so it starts out of the way.
    defaultCollapsed: true,
    component: WorktreesPanel,
  });

  // Ships unbound (palette-only), like the built-in session commands — it
  // reveals the panel and opens its create form.
  ctx.registerCommand({
    id: "newWorktreeSession",
    label: "Worktrees: New Worktree Session…",
    run: () => {
      revealSidebarPanel?.(PANEL_ID);
      requestCreateForm();
    },
  });

  // Same handoff, but preselects the first configured agent preset — for
  // when starting an agent is the point, not an afterthought.
  ctx.registerCommand({
    id: "newAgentSession",
    label: "Worktrees: New Agent Session…",
    run: () => {
      revealSidebarPanel?.(PANEL_ID);
      const presets = parseAgentPresets(ctx.settings.get("worktrees.agents"));
      requestCreateForm(presets.length > 0 ? 0 : null);
    },
  });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  pendingCreateListeners.clear();
  pendingCreate = false;
}

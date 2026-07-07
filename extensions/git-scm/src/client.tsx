// git-scm: a VS Code-style SOURCE CONTROL sidebar panel (stage/unstage/
// discard/commit/push/pull/sync) plus a diff viewer tab. GitPanel takes no
// props (registerSidebarPanel's component signature) and DiffView is reached
// only via ctx.app.openViewerTab (registered with extensions: [] so it's
// never auto-matched to a file) — both read the small set of host hooks
// (serverFetch, active context, settings, openViewerTab/openFileTab/
// refreshFiles) from module-level bridge variables set once in activate(),
// the same pattern live-preview's client.tsx uses for ctx.settings.
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";

// ---- Module-level host bridge ----

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}
interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let getActiveContext: (() => ActiveContext) | null = null;
let onDidChangeContext: ((cb: (ctx: ActiveContext) => void) => () => void) | null = null;
let openViewerTab: ((viewerId: string, path: string, opts?: { title?: string }) => void) | null = null;
let openFileTab: ((path: string) => void) | null = null;
let refreshFiles: (() => void) | null = null;
let setSidebarBadge: ((panelId: string, badge: number | null) => void) | null = null;
let extSettings: SettingsApi | null = null;
let removeStylesheet: (() => void) | null = null;
let removeContextListener: (() => void) | null = null;
let removeSettingsListener: (() => void) | null = null;

// Credentials from a successful push/pull/sync retry, kept in memory only
// (never localStorage, never the remote URL) so repeated syncs in the same
// browser tab don't re-prompt — cleared on a full page reload. Shared
// across every repo the panel visits in this tab; fine for a single-user
// local dev tool where re-prompting per-remote would just be friction.
let sessionCredentials: { username: string; password: string } | null = null;

function readPollInterval(): number {
  const raw = Number(extSettings?.get("gitScm.pollInterval"));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.max(1000, raw);
}

type ClickAction = "diff" | "edit";

function readClickAction(): ClickAction {
  return extSettings?.get("gitScm.clickAction") === "edit" ? "edit" : "diff";
}

// ---- Status types (mirrors server.js's parseStatus output) ----

type FileStatus = "modified" | "added" | "deleted" | "untracked" | "renamed" | "conflicted";

interface FileEntry {
  path: string;
  origPath?: string;
  status: FileStatus;
}

interface StatusResponse {
  root: string | null;
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  staged?: FileEntry[];
  unstaged?: FileEntry[];
  conflicted?: FileEntry[];
}

const STATUS_LABEL: Record<FileStatus, string> = {
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
  renamed: "R",
  conflicted: "!",
};

function basenameOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}
// Immediate parent directory name only (e.g. "components" for
// "client/src/components/Foo.tsx"), not the full relative path.
function dirOf(p: string): string {
  const slash = p.lastIndexOf("/");
  if (slash === -1) return "";
  const dir = p.slice(0, slash);
  const parentSlash = dir.lastIndexOf("/");
  return parentSlash === -1 ? dir : dir.slice(parentSlash + 1);
}

// ---- Diff tab composite key ----
// A diff tab's `filePath` (what persists as Tab.extViewerPath) has to carry
// everything DiffView needs to refetch after a reload — cwd, the repo-
// relative path, which side (staged/working), whether it's untracked, and
// a rename's orig path — since a transient in-memory map would be empty
// after a fresh page load. NUL can't appear in any of these fields, so it's
// a safe join separator. This composite string is never shown to the user;
// the tab's visible title is set separately via openViewerTab's `title`.
const KEY_SEP = "\u0000";

function encodeDiffKey(cwd: string, path: string, staged: boolean, untracked: boolean, origPath?: string): string {
  return [cwd, path, staged ? "1" : "0", untracked ? "1" : "0", origPath ?? ""].join(KEY_SEP);
}

function decodeDiffKey(key: string): {
  cwd: string;
  path: string;
  staged: boolean;
  untracked: boolean;
  origPath?: string;
} {
  const [cwd, path, stagedFlag, untrackedFlag, origPath] = key.split(KEY_SEP);
  return { cwd, path, staged: stagedFlag === "1", untracked: untrackedFlag === "1", origPath: origPath || undefined };
}

// ---- Shared fetch helpers ----

class ApiError extends Error {
  authRequired?: boolean;
  constructor(message: string, authRequired?: boolean) {
    super(message);
    this.authRequired = authRequired;
  }
}

async function apiPost(path: string, body: unknown): Promise<void> {
  const res = await serverFetch!(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}) as { error?: string; authRequired?: boolean });
    throw new ApiError(data.error || `${res.status} ${res.statusText}`, data.authRequired);
  }
}

async function apiGetJson<T>(path: string): Promise<T> {
  const res = await serverFetch!(path);
  const data = await res.json().catch(() => ({}) as Record<string, never>);
  if (!res.ok) throw new ApiError((data as { error?: string }).error || `${res.status} ${res.statusText}`);
  return data as T;
}

// ---- Small presentational pieces ----

interface RowAction {
  icon: string;
  title: string;
  onClick: () => void;
}

function FileRow({
  entry,
  onOpen,
  actions,
  clickHint,
}: {
  entry: FileEntry;
  onOpen: (e: { shiftKey: boolean }) => void;
  actions: RowAction[];
  // Discoverability for the shift-click escape hatch — there's no visual
  // affordance for it otherwise, so it rides along in the row's own native
  // tooltip. Omitted for conflicted entries, which ignore the click setting.
  clickHint?: string;
}) {
  const dir = dirOf(entry.path);
  const label = entry.origPath ? `${basenameOf(entry.origPath)} → ${basenameOf(entry.path)}` : basenameOf(entry.path);
  const title = clickHint ? `${entry.path}\n${clickHint}` : entry.path;
  return (
    <div className="git-row" title={title} onClick={(e) => onOpen(e)}>
      <span className={`git-row-status git-status-${entry.status}`}>{STATUS_LABEL[entry.status]}</span>
      <span className="git-row-name">{label}</span>
      {dir && <span className="git-row-dir">{dir}</span>}
      <span className="git-row-actions" onClick={(e) => e.stopPropagation()}>
        {actions.map((a) => (
          <button key={a.title} className="icon-button" title={a.title} onClick={a.onClick}>
            <Icon name={a.icon} />
          </button>
        ))}
      </span>
    </div>
  );
}

function GroupHeader({
  title,
  count,
  actions,
}: {
  title: string;
  count: number;
  actions?: RowAction[];
}) {
  return (
    <div className="git-group-header">
      <span className="git-group-title">{title}</span>
      <span className="git-group-count">{count}</span>
      <span className="git-group-actions">
        {actions?.map((a) => (
          <button key={a.title} className="icon-button" title={a.title} onClick={a.onClick}>
            <Icon name={a.icon} />
          </button>
        ))}
      </span>
    </div>
  );
}

// ---- Background status polling ----
// Drives the Source Control sidebar badge independent of GitPanel's mount
// state. Sidebar.tsx only mounts GitPanel once the git tab is selected, so
// without this the badge stayed empty until the user opened the tab at
// least once. Started/stopped from activate()/deactivate(); GitPanel
// subscribes to the same status stream instead of fetching its own copy.
let currentStatus: StatusResponse | null = null;
const statusListeners = new Set<(status: StatusResponse | null) => void>();
const fetchErrorListeners = new Set<(message: string) => void>();
let pollCwd: string | null = null;
let pollTimer: number | null = null;
let lastPollMs = 0;

function updateBadge(status: StatusResponse | null) {
  if (!status?.root) {
    setSidebarBadge?.("git", null);
    return;
  }
  const distinct = new Set(
    [...(status.staged ?? []), ...(status.unstaged ?? []), ...(status.conflicted ?? [])].map((e) => e.path),
  );
  setSidebarBadge?.("git", distinct.size > 0 ? distinct.size : null);
}

function setSharedStatus(next: StatusResponse | null) {
  currentStatus = next;
  updateBadge(next);
  statusListeners.forEach((cb) => cb(next));
}

async function fetchStatus(cwd: string) {
  try {
    const data = await apiGetJson<StatusResponse>(`/status?cwd=${encodeURIComponent(cwd)}`);
    setSharedStatus(data);
  } catch (err) {
    setSharedStatus(null);
    const message = err instanceof Error ? err.message : String(err);
    fetchErrorListeners.forEach((cb) => cb(message));
  }
}

function refreshStatus() {
  if (pollCwd) fetchStatus(pollCwd);
}

function restartPolling() {
  if (pollTimer != null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  lastPollMs = readPollInterval();
  if (!pollCwd) {
    setSharedStatus(null);
    return;
  }
  fetchStatus(pollCwd);
  if (lastPollMs > 0) {
    pollTimer = window.setInterval(() => fetchStatus(pollCwd!), lastPollMs);
  }
}

function setPollCwd(cwd: string | null) {
  if (cwd === pollCwd) return;
  pollCwd = cwd;
  restartPolling();
}

function onSettingsChanged() {
  if (readPollInterval() !== lastPollMs) restartPolling();
}

// ---- GitPanel (registerSidebarPanel component — no props) ----

type NetworkKind = "push" | "pull" | "sync";

// Structurally matches the host's SidebarPanelHostProps (client/src/
// extensions.ts) — a local copy, not an import, per extensions/_shared's
// module comment on why extension code never imports client/src internals.
interface PanelProps {
  actionsTarget?: HTMLDivElement | null;
}

function GitPanel({ actionsTarget }: PanelProps) {
  const [activeCwd, setActiveCwd] = useState<string | null>(() => getActiveContext?.().cwd ?? null);
  const [status, setStatus] = useState<StatusResponse | null>(() => currentStatus);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [credentialPrompt, setCredentialPrompt] = useState<{ kind: NetworkKind; error: string } | null>(null);
  const [credUsername, setCredUsername] = useState("");
  const [credPassword, setCredPassword] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState<{ paths: string[]; untracked: string[] } | null>(null);
  const [clickAction, setClickAction] = useState(readClickAction);

  useEffect(() => onDidChangeContext?.((ctx) => setActiveCwd(ctx.cwd)), []);
  useEffect(() => extSettings?.onDidChange(() => setClickAction(readClickAction())), []);

  // Status comes from the module-level poller (started in activate(), kept
  // alive regardless of whether this panel is mounted) rather than a fetch
  // owned by this component — see the "Background status polling" section.
  useEffect(() => {
    setStatus(currentStatus);
    statusListeners.add(setStatus);
    return () => {
      statusListeners.delete(setStatus);
    };
  }, []);
  useEffect(() => {
    fetchErrorListeners.add(setError);
    return () => {
      fetchErrorListeners.delete(setError);
    };
  }, []);

  const refresh = useCallback(() => {
    refreshStatus();
  }, []);

  const afterMutate = useCallback(async () => {
    refreshStatus();
    refreshFiles?.();
  }, []);

  const runOp = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await afterMutate();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [afterMutate],
  );

  const stage = (paths: string[]) => runOp(() => apiPost("/stage", { cwd: activeCwd, paths }));
  const unstage = (paths: string[]) => runOp(() => apiPost("/unstage", { cwd: activeCwd, paths }));
  const discard = (paths: string[], untracked: string[]) =>
    runOp(() => apiPost("/discard", { cwd: activeCwd, paths, untracked }));
  const commit = () =>
    runOp(async () => {
      await apiPost("/commit", { cwd: activeCwd, message });
      setMessage("");
    });

  const runNetwork = useCallback(
    (kind: NetworkKind, creds?: { username: string; password: string }) => {
      const useCreds = creds ?? sessionCredentials ?? undefined;
      return runOp(async () => {
        try {
          await apiPost(`/${kind}`, { cwd: activeCwd, ...useCreds });
          if (creds) sessionCredentials = creds;
          setCredentialPrompt(null);
        } catch (err) {
          if (err instanceof ApiError && err.authRequired) {
            setCredentialPrompt({ kind, error: err.message });
            return;
          }
          throw err;
        }
      });
    },
    [activeCwd, runOp],
  );

  const submitCredentials = () => {
    if (!credentialPrompt) return;
    runNetwork(credentialPrompt.kind, { username: credUsername, password: credPassword });
    setCredPassword("");
  };

  // Shift+click always opens the OTHER action from gitScm.clickAction's
  // configured default — same escape-hatch convention the host uses for
  // preview vs. edit (QuickSwitcher's Shift+Enter, FileTree's hover icon).
  // Conflicted entries are the one exception: there's no meaningful diff
  // for an unmerged path (nothing to compare — both sides are still live
  // conflict markers in the working tree), so they always open in nvim to
  // resolve, regardless of the setting or the click.
  const openEntry = (entry: FileEntry, staged: boolean, shiftKey: boolean) => {
    if (!activeCwd) return;
    if (entry.status === "conflicted") {
      openFileTab?.(`${activeCwd}/${entry.path}`);
      return;
    }
    const wantsEdit = shiftKey ? clickAction !== "edit" : clickAction === "edit";
    if (wantsEdit) {
      openFileTab?.(`${activeCwd}/${entry.path}`);
      return;
    }
    const untracked = entry.status === "untracked";
    const key = encodeDiffKey(activeCwd, entry.path, staged, untracked, entry.origPath);
    const title = `${basenameOf(entry.path)} (${staged ? "Staged" : "Working Tree"})`;
    openViewerTab?.("diff", key, { title });
  };

  if (!activeCwd) {
    return <div className="git-empty">No active directory.</div>;
  }
  if (!status) {
    return <div className="git-empty">Loading…</div>;
  }
  if (!status.root) {
    return <div className="git-empty">Not a git repository.</div>;
  }

  const staged = status.staged ?? [];
  const unstaged = status.unstaged ?? [];
  const conflicted = status.conflicted ?? [];
  const changes = [...conflicted, ...unstaged];
  const untrackedPaths = unstaged.filter((e) => e.status === "untracked").map((e) => e.path);
  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  const clickHint = `Shift+Click: ${clickAction === "edit" ? "Open Diff" : "Open in Editor"}`;

  const headerActions = (
    <>
      <button
        className="git-sync-button"
        disabled={busy}
        title={status.upstream ? `Sync with ${status.upstream}` : "Publish branch"}
        onClick={() => runNetwork("sync")}
      >
        <Icon name="sync" />
        {status.upstream && (
          <span className="git-sync-counts">
            {behind > 0 && (
              <>
                <Icon name="arrow-down" />
                {behind}
              </>
            )}
            {ahead > 0 && (
              <>
                <Icon name="arrow-up" />
                {ahead}
              </>
            )}
          </span>
        )}
      </button>
      <button className="icon-button" title="Refresh" disabled={busy} onClick={refresh}>
        <Icon name="refresh" />
      </button>
    </>
  );

  return (
    <div className="git-panel">
      {actionsTarget && createPortal(headerActions, actionsTarget)}
      {error && (
        <div className="git-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <div className="git-commit-box">
        <textarea
          className="git-commit-message"
          placeholder={`Message (${status.branch ?? "detached HEAD"})`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={busy}
        />
        <button
          className="git-commit-button"
          disabled={busy || !message.trim() || staged.length === 0}
          title={staged.length === 0 ? "No staged changes" : "Commit staged changes"}
          onClick={commit}
        >
          <Icon name="check" /> Commit
        </button>
      </div>

      {credentialPrompt && (
        <div className="git-credential-form">
          <div className="git-credential-error">{credentialPrompt.error}</div>
          <input
            className="git-credential-input"
            placeholder="Username"
            value={credUsername}
            onChange={(e) => setCredUsername(e.target.value)}
            autoFocus
          />
          <input
            className="git-credential-input"
            placeholder="Password / token"
            type="password"
            value={credPassword}
            onChange={(e) => setCredPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCredentials();
              if (e.key === "Escape") setCredentialPrompt(null);
            }}
          />
          <div className="git-credential-buttons">
            <button className="git-credential-cancel" onClick={() => setCredentialPrompt(null)}>
              Cancel
            </button>
            <button className="git-credential-submit" onClick={submitCredentials} disabled={!credUsername}>
              Retry
            </button>
          </div>
        </div>
      )}

      {confirmDiscard && (
        <div className="git-confirm">
          <div className="git-confirm-text">
            {confirmDiscard.paths.length === 1
              ? `Discard changes in ${basenameOf(confirmDiscard.paths[0])}?`
              : `Discard changes in ${confirmDiscard.paths.length} files?`}
            {confirmDiscard.untracked.length > 0 && " This deletes untracked file(s)."}
          </div>
          <div className="git-confirm-buttons">
            <button className="git-credential-cancel" onClick={() => setConfirmDiscard(null)}>
              Cancel
            </button>
            <button
              className="git-confirm-discard"
              onClick={() => {
                discard(confirmDiscard.paths, confirmDiscard.untracked);
                setConfirmDiscard(null);
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      <div className="git-groups">
        {staged.length > 0 && (
          <div className="git-group">
            <GroupHeader
              title="Staged Changes"
              count={staged.length}
              actions={[
                {
                  icon: "remove",
                  title: "Unstage All Changes",
                  onClick: () => unstage(staged.map((e) => e.path)),
                },
              ]}
            />
            {staged.map((entry) => (
              <FileRow
                key={entry.path}
                entry={entry}
                onOpen={(e) => openEntry(entry, true, e.shiftKey)}
                clickHint={clickHint}
                actions={[
                  { icon: "remove", title: "Unstage Changes", onClick: () => unstage([entry.path]) },
                ]}
              />
            ))}
          </div>
        )}

        {changes.length > 0 && (
          <div className="git-group">
            <GroupHeader
              title="Changes"
              count={changes.length}
              actions={[
                {
                  icon: "add",
                  title: "Stage All Changes",
                  onClick: () => stage(changes.map((e) => e.path)),
                },
                ...(unstaged.length > 0
                  ? [
                      {
                        icon: "discard",
                        title: "Discard All Changes",
                        onClick: () =>
                          setConfirmDiscard({ paths: unstaged.map((e) => e.path), untracked: untrackedPaths }),
                      },
                    ]
                  : []),
              ]}
            />
            {changes.map((entry) => {
              const isConflicted = entry.status === "conflicted";
              const actions: RowAction[] = isConflicted
                ? [{ icon: "add", title: "Stage Changes", onClick: () => stage([entry.path]) }]
                : [
                    {
                      icon: "discard",
                      title: "Discard Changes",
                      onClick: () =>
                        setConfirmDiscard({
                          paths: [entry.path],
                          untracked: entry.status === "untracked" ? [entry.path] : [],
                        }),
                    },
                    { icon: "add", title: "Stage Changes", onClick: () => stage([entry.path]) },
                  ];
              return (
                <FileRow
                  key={entry.path}
                  entry={entry}
                  onOpen={(e) => openEntry(entry, false, e.shiftKey)}
                  clickHint={isConflicted ? undefined : clickHint}
                  actions={actions}
                />
              );
            })}
          </div>
        )}

        {staged.length === 0 && changes.length === 0 && (
          <div className="git-empty">No changes.</div>
        )}
      </div>
    </div>
  );
}

// ---- DiffView (registerFileViewer component, extensions: []) ----

interface DiffProps {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  openInEditor?: (path: string) => void;
}

function parseHunks(diffText: string): { header: string; lines: { kind: "add" | "del" | "ctx"; text: string }[] }[] {
  const hunks: { header: string; lines: { kind: "add" | "del" | "ctx"; text: string }[] }[] = [];
  let current: (typeof hunks)[number] | null = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("@@")) {
      current = { header: line, lines: [] };
      hunks.push(current);
    } else if (current) {
      if (line.startsWith("+")) current.lines.push({ kind: "add", text: line.slice(1) });
      else if (line.startsWith("-")) current.lines.push({ kind: "del", text: line.slice(1) });
      else if (line.startsWith(" ")) current.lines.push({ kind: "ctx", text: line.slice(1) });
      // Lines like "\ No newline at end of file" are dropped — nothing
      // useful to render for a unified-diff viewer.
    }
  }
  return hunks;
}

function DiffView({ filePath, active, toolbarTarget, openInEditor }: DiffProps) {
  const parsed = useMemo(() => decodeDiffKey(filePath), [filePath]);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiffText(null);
    setError(null);
    const params = new URLSearchParams({
      cwd: parsed.cwd,
      path: parsed.path,
      staged: parsed.staged ? "1" : "0",
      untracked: parsed.untracked ? "1" : "0",
    });
    if (parsed.origPath) params.set("origPath", parsed.origPath);
    apiGetJson<{ diff: string }>(`/diff?${params}`)
      .then((data) => {
        if (!cancelled) setDiffText(data.diff);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, parsed]);

  const hunks = useMemo(() => (diffText ? parseHunks(diffText) : []), [diffText]);

  const controls = (
    <button
      className="icon-button"
      title="Open in Editor"
      onClick={() => openInEditor?.(`${parsed.cwd}/${parsed.path}`)}
    >
      <Icon name="go-to-file" />
    </button>
  );

  return (
    <div className={`git-diff-host${active ? "" : " hidden"}`}>
      {error && <div className="git-diff-status git-diff-error">{error}</div>}
      {!error && diffText === null && <div className="git-diff-status">Loading…</div>}
      {!error && diffText !== null && diffText === "" && (
        <div className="git-diff-status">No differences.</div>
      )}
      {/* A pure rename (100% similarity) or a mode-only/binary change
          produces diff header lines but no "@@" hunks — fall back to the
          raw diff text rather than rendering a blank pane. */}
      {!error && diffText !== null && diffText !== "" && hunks.length === 0 && (
        <pre className="git-diff-raw">{diffText}</pre>
      )}
      {!error && hunks.length > 0 && (
        <div className="git-diff-body">
          {hunks.map((hunk, i) => (
            <div key={i} className="git-diff-hunk">
              <div className="git-diff-hunk-header">{hunk.header}</div>
              {hunk.lines.map((line, j) => (
                <div key={j} className={`git-diff-line git-diff-line-${line.kind}`}>
                  <span className="git-diff-line-marker">
                    {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                  </span>
                  <span className="git-diff-line-text">{line.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {active && toolbarTarget && createPortal(controls, toolbarTarget)}
    </div>
  );
}

// ---- activate() ----

export function activate(ctx: {
  registerSidebarPanel: (p: {
    id: string;
    title: string;
    icon?: string;
    component: typeof GitPanel;
  }) => void;
  registerFileViewer: (v: {
    id: string;
    extensions: string[];
    mode?: "default" | "preview";
    component: typeof DiffView;
  }) => void;
  app: {
    getActiveContext: () => ActiveContext;
    onDidChangeContext: (cb: (ctx: ActiveContext) => void) => () => void;
    openFileTab: (path: string) => void;
    openViewerTab: (viewerId: string, path: string, opts?: { title?: string }) => void;
    refreshFiles: () => void;
    setSidebarBadge: (panelId: string, badge: number | null) => void;
  };
  serverFetch: (path: string, init?: RequestInit) => Promise<Response>;
  assetUrl: (relPath: string) => string;
  settings: SettingsApi;
}) {
  serverFetch = ctx.serverFetch;
  getActiveContext = ctx.app.getActiveContext;
  onDidChangeContext = ctx.app.onDidChangeContext;
  openViewerTab = ctx.app.openViewerTab;
  openFileTab = ctx.app.openFileTab;
  refreshFiles = ctx.app.refreshFiles;
  setSidebarBadge = ctx.app.setSidebarBadge;
  extSettings = ctx.settings;

  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerSidebarPanel({
    id: "git",
    title: "Source Control",
    icon: "source-control",
    component: GitPanel,
  });
  // extensions: [] — never auto-matched to a file; reached only via
  // ctx.app.openViewerTab from GitPanel's row clicks (see openDiff above).
  ctx.registerFileViewer({ id: "diff", extensions: [], mode: "default", component: DiffView });

  // Start the badge poller immediately so it's correct on app startup,
  // rather than only after the user opens the Source Control tab.
  setPollCwd(ctx.app.getActiveContext().cwd);
  removeContextListener = ctx.app.onDidChangeContext((c) => setPollCwd(c.cwd));
  removeSettingsListener = ctx.settings.onDidChange(onSettingsChanged);
}

export function deactivate() {
  removeContextListener?.();
  removeContextListener = null;
  removeSettingsListener?.();
  removeSettingsListener = null;
  if (pollTimer != null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  pollCwd = null;
  currentStatus = null;
  setSidebarBadge?.("git", null);
  removeStylesheet?.();
  removeStylesheet = null;
}

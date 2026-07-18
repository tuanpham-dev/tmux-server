// git-scm: a VS Code-style SOURCE CONTROL sidebar panel (stage/unstage/
// discard/commit/push/pull/sync) plus a diff viewer tab. GitPanel takes no
// props (registerSidebarPanel's component signature) and DiffView is reached
// only via ctx.app.openViewerTab (registered with extensions: [] so it's
// never auto-matched to a file) — both read the small set of host hooks
// (serverFetch, active context, settings, openViewerTab/openFileTab/
// refreshFiles) from module-level bridge variables set once in activate(),
// the same pattern live-preview's client.tsx uses for ctx.settings.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";
import FileIcon from "../../_shared/FileIcon";
import type { IconResult } from "../../_shared/FileIcon";
import type { MenuItem } from "../../_shared/types";
import { useListNavigation } from "../../_shared/useListNavigation";
import { useMarqueeSelection } from "../../_shared/useMarqueeSelection";

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
let getFileIcon: ((fileName: string) => IconResult) | null = null;
let getFolderIcon: ((folderName: string, expanded: boolean) => IconResult) | null = null;
let onDidChangeIconTheme: ((cb: () => void) => () => void) | null = null;
let removeStylesheet: (() => void) | null = null;
let removeContextListener: (() => void) | null = null;
let removeSettingsListener: (() => void) | null = null;

function readPollInterval(): number {
  const raw = Number(extSettings?.get("gitScm.pollInterval"));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.max(1000, raw);
}

type ClickAction = "diff" | "edit";

function readClickAction(): ClickAction {
  return extSettings?.get("gitScm.clickAction") === "edit" ? "edit" : "diff";
}

// ---- View mode (list vs. tree) ----
// Panel-side toggle, not an extension setting — SettingsApi is read-only
// (get/onDidChange), so this can't be written through ctx.settings. Mirrors
// the host's own Sidebar.tsx sidebarMode localStorage key.
type ViewMode = "list" | "tree";
const VIEW_MODE_KEY = "gitScm.viewMode";

function readViewMode(): ViewMode {
  return localStorage.getItem(VIEW_MODE_KEY) === "tree" ? "tree" : "list";
}

function writeViewMode(mode: ViewMode) {
  localStorage.setItem(VIEW_MODE_KEY, mode);
}

// ---- Collapsed directory state (tree mode) ----
// Persisted per repo root + group + dir path so collapse state survives a
// reload without leaking between repos or groups. Pruned lazily on write —
// only keys for the *current* repo root are checked against live dir nodes;
// keys for other repos can't be validated here and are left untouched.
const COLLAPSED_DIRS_KEY = "gitScm.collapsedDirs";

function readCollapsedDirs(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_DIRS_KEY) ?? "[]");
    return Array.isArray(raw) ? new Set(raw.filter((x) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsedDirs(keys: Set<string>) {
  localStorage.setItem(COLLAPSED_DIRS_KEY, JSON.stringify([...keys]));
}

// ---- Status types (mirrors server.js's parseStatus output) ----

type FileStatus = "modified" | "added" | "deleted" | "untracked" | "renamed" | "conflicted";

interface FileEntry {
  path: string;
  origPath?: string;
  status: FileStatus;
}

type OperationKind = "merge" | "rebase" | "cherry-pick" | "revert";

const OPERATION_LABEL: Record<OperationKind, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
};

interface StatusResponse {
  root: string | null;
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  staged?: FileEntry[];
  unstaged?: FileEntry[];
  conflicted?: FileEntry[];
  operation?: OperationKind | null;
  // .git/MERGE_MSG content while operation is truthy — also written for a
  // conflicted cherry-pick/revert, not just a merge. Used to prefill the
  // commit box once per operation (see GitPanel's prefill effect).
  mergeMsg?: string | null;
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

// ---- Tree view ----

interface TreeDirNode {
  kind: "dir";
  // Full path from the repo root, e.g. "client/src/components" — a single
  // node here can represent several collapsed directory levels (see
  // buildTree's chain compression), so this is NOT always one path segment.
  path: string;
  name: string;
  children: TreeNode[];
}
interface TreeFileNode {
  kind: "file";
  entry: FileEntry;
}
type TreeNode = TreeDirNode | TreeFileNode;

// The three status groups a file row can belong to — shared by the tree
// builder, the selection state (confined to one group at a time, see
// GitPanel), and the context-menu builders.
type GroupKey = "conflicted" | "staged" | "unstaged";

// Converts a group's flat file list into a nested directory tree, matching
// VS Code's SCM tree: directories sort before files, both alphabetically;
// files keep the order the server returned them in (server already applies
// its own porcelain ordering, not re-sorted here). A directory chain with
// only one child at every level (e.g. "client" -> "src" -> "components", each
// having exactly one entry) collapses into a single row labeled
// "client/src/components" rather than three nested rows.
function buildTree(entries: FileEntry[]): TreeNode[] {
  interface MutableDir {
    path: string;
    name: string;
    dirs: Map<string, MutableDir>;
    files: FileEntry[];
  }
  const root: MutableDir = { path: "", name: "", dirs: new Map(), files: [] };
  for (const entry of entries) {
    const segments = entry.path.split("/");
    const fileName = segments.pop()!;
    let cur = root;
    let curPath = "";
    for (const seg of segments) {
      curPath = curPath ? `${curPath}/${seg}` : seg;
      let next = cur.dirs.get(seg);
      if (!next) {
        next = { path: curPath, name: seg, dirs: new Map(), files: [] };
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    cur.files.push(entry);
  }

  function toNodes(dir: MutableDir): TreeNode[] {
    const dirNodes = [...dir.dirs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d): TreeDirNode => {
        // Compress a single-child chain (one subdir, no files) into this
        // node's own label, e.g. "src" swallowing "components" -> "src/components".
        let chain = d;
        let label = d.name;
        while (chain.files.length === 0 && chain.dirs.size === 1) {
          const [only] = chain.dirs.values();
          label = `${label}/${only.name}`;
          chain = only;
        }
        return { kind: "dir", path: chain.path, name: label, children: toNodes(chain) };
      });
    const fileNodes: TreeFileNode[] = dir.files.map((entry) => ({ kind: "file", entry }));
    return [...dirNodes, ...fileNodes];
  }

  return toNodes(root);
}

// Every collapsed-dir key ("${keyPrefix}:${dirPath}") derivable from a
// group's current tree — used both to render DirRow's collapse key and to
// prune stale keys for dirs that no longer exist (see toggleDir).
function collectDirKeys(keyPrefix: string, nodes: TreeNode[], out: Set<string>) {
  for (const node of nodes) {
    if (node.kind === "dir") {
      out.add(`${keyPrefix}:${node.path}`);
      collectDirKeys(keyPrefix, node.children, out);
    }
  }
}

// All FileEntry values under a tree node (recursively) — used to build the
// path arrays for a directory row's aggregate stage/unstage/discard actions.
function collectEntries(nodes: TreeNode[]): FileEntry[] {
  const out: FileEntry[] = [];
  for (const node of nodes) {
    if (node.kind === "file") out.push(node.entry);
    else out.push(...collectEntries(node.children));
  }
  return out;
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

// A conflict tab's key only ever needs cwd + path (there's no staged/
// working-tree distinction for an unmerged path — see openEntry) — reusing
// KEY_SEP keeps decode symmetric with encodeDiffKey even though there's
// nothing else to encode.
function encodeConflictKey(cwd: string, path: string): string {
  return [cwd, path].join(KEY_SEP);
}

function decodeConflictKey(key: string): { cwd: string; path: string } {
  const [cwd, path] = key.split(KEY_SEP);
  return { cwd, path };
}

// ---- Shared fetch helpers ----

class ApiError extends Error {
  cancelled?: boolean;
  constructor(message: string, cancelled?: boolean) {
    super(message);
    this.cancelled = cancelled;
  }
}

async function apiPost(path: string, body: unknown): Promise<void> {
  const res = await serverFetch!(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}) as { error?: string; cancelled?: boolean });
    throw new ApiError(data.error || `${res.status} ${res.statusText}`, data.cancelled);
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
  group,
  selected,
  onRowClick,
  onRowContextMenu,
  actions,
  clickHint,
  depth,
  hideDir,
  tabIndex,
  rowRef,
  onRowFocus,
}: {
  entry: FileEntry;
  // Which status group this row belongs to — rendered as a data attribute
  // so the marquee-selection hit-test (GitPanel's getRows) can enumerate
  // rows by querying the DOM rather than needing its own row registry (the
  // FILES tree already has one — rowRefs — git-scm doesn't).
  group: GroupKey;
  // Whether this row is part of the panel's active multi-selection — drives
  // the .selected highlight, same convention as FileTree.tsx's file rows.
  selected: boolean;
  // Raw event pass-through — GitPanel's handleRowClick owns the full click
  // precedence (secondary-open, toggle-select, range-select, plain select),
  // same split as FileTree.tsx's handleRowClick.
  onRowClick: (e: ReactMouseEvent) => void;
  onRowContextMenu: (e: ReactMouseEvent) => void;
  actions: RowAction[];
  // Discoverability for the Shift-click escape hatch — there's no visual
  // affordance for it otherwise, so it rides along in the row's own native
  // tooltip. Omitted for conflicted entries, which ignore the click setting.
  clickHint?: string;
  // Tree mode: indent level (each level = one row's worth of chevron+gap)
  // and suppress the parent-dir hint, since the tree's own DirRow ancestry
  // already shows that information.
  depth?: number;
  hideDir?: boolean;
  // Roving-tabindex keyboard nav (GitPanel's resultNav — see
  // useListNavigation) — a plain prop rather than a forwarded React ref
  // since rowRef is a callback consumed directly as this root div's own
  // `ref`, not passed further up.
  tabIndex?: number;
  rowRef?: (el: HTMLElement | null) => void;
  onRowFocus?: () => void;
}) {
  const dir = !hideDir ? dirOf(entry.path) : "";
  const label = entry.origPath ? `${basenameOf(entry.origPath)} → ${basenameOf(entry.path)}` : basenameOf(entry.path);
  const title = clickHint ? `${entry.path}\n${clickHint}` : entry.path;
  // Icon always resolves from the *new* path's basename — same side the
  // rename label's arrow points to.
  const icon = getFileIcon?.(basenameOf(entry.path)) ?? { kind: "none" as const };
  return (
    <div
      className={`git-row${selected ? " selected" : ""}`}
      title={title}
      data-group={group}
      data-path={entry.path}
      onClick={onRowClick}
      onContextMenu={onRowContextMenu}
      style={depth ? { paddingLeft: 8 + depth * 16 } : undefined}
      tabIndex={tabIndex}
      ref={rowRef}
      onFocus={onRowFocus}
    >
      <FileIcon className="git-row-icon" result={icon} />
      <span className="git-row-name">{label}</span>
      {dir && <span className="git-row-dir">{dir}</span>}
      <span className="git-row-trailer">
        <span className="git-row-actions" onClick={(e) => e.stopPropagation()}>
          {actions.map((a) => (
            <button key={a.title} className="icon-button" title={a.title} tabIndex={-1} onClick={a.onClick}>
              <Icon name={a.icon} />
            </button>
          ))}
        </span>
        <span className={`git-row-status git-status-${entry.status}`}>{STATUS_LABEL[entry.status]}</span>
      </span>
    </div>
  );
}

function DirRow({
  node,
  depth,
  collapsed,
  onToggle,
  actions,
  tabIndex,
  rowRef,
  onRowFocus,
}: {
  node: TreeDirNode;
  depth: number;
  collapsed: boolean;
  onToggle: () => void;
  actions: RowAction[];
  tabIndex?: number;
  rowRef?: (el: HTMLElement | null) => void;
  onRowFocus?: () => void;
}) {
  // A compressed chain's name ("client/src/components") resolves its folder
  // icon from the last segment — icon themes key folderNames on a single
  // directory name, and (matching VS Code) a compressed node's underlying
  // resource is that leaf directory; the joined label is display-only.
  const lastSegment = node.name.slice(node.name.lastIndexOf("/") + 1);
  const icon = getFolderIcon?.(lastSegment, !collapsed) ?? { kind: "none" as const };
  return (
    <div
      className="git-row git-dir-row"
      title={node.path}
      onClick={onToggle}
      style={{ paddingLeft: 8 + depth * 16 }}
      tabIndex={tabIndex}
      ref={rowRef}
      onFocus={onRowFocus}
    >
      <Icon name={collapsed ? "chevron-right" : "chevron-down"} className="git-dir-row-chevron" />
      <FileIcon className="git-row-icon" result={icon} />
      <span className="git-row-name">{node.name}</span>
      <span className="git-row-trailer">
        <span className="git-row-actions" onClick={(e) => e.stopPropagation()}>
          {actions.map((a) => (
            <button key={a.title} className="icon-button" title={a.title} tabIndex={-1} onClick={a.onClick}>
              <Icon name={a.icon} />
            </button>
          ))}
        </span>
      </span>
    </div>
  );
}

function GroupHeader({
  title,
  count,
  actions,
  tabIndex,
  rowRef,
  onRowFocus,
}: {
  title: string;
  count: number;
  actions?: RowAction[];
  // Group headers are keyboard focus stops (unlike a plain list-widget
  // header would default to) — see plans/keyboard-nav-context-menus-
  // sessions-search-git.md's T10 note: this keeps the header's Stage All /
  // Unstage All / Discard All actions Tab-reachable from a focused header.
  tabIndex?: number;
  rowRef?: (el: HTMLElement | null) => void;
  onRowFocus?: () => void;
}) {
  return (
    <div className="git-group-header" tabIndex={tabIndex} ref={rowRef} onFocus={onRowFocus}>
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

// Mirrors server.js's pending-prompt shape: kind drives which form variant
// renders, prompt is git/ssh's own text shown verbatim (for hostkey it
// carries the fingerprint the user is confirming).
interface AuthPrompt {
  id: string;
  kind: "username" | "password" | "passphrase" | "hostkey" | "generic";
  prompt: string;
}

// Structurally matches the host's SidebarPanelHostProps (client/src/
// extensions.ts) — a local copy, not an import, per extensions/_shared's
// module comment on why extension code never imports client/src internals.
interface PanelProps {
  actionsTarget?: HTMLDivElement | null;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
}

function GitPanel({ actionsTarget, showMenu }: PanelProps) {
  const [activeCwd, setActiveCwd] = useState<string | null>(() => getActiveContext?.().cwd ?? null);
  const [status, setStatus] = useState<StatusResponse | null>(() => currentStatus);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  // Interactive auth prompt relayed from the server while a network op is
  // in flight (see server.js's askpass relay) — polled below in runNetwork.
  // authSecret doubles as password/passphrase/generic-answer depending on
  // the prompt kind; the id-compare in the poll keeps a rerender from
  // clobbering in-progress typing.
  const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null);
  const [authUsername, setAuthUsername] = useState("");
  const [authSecret, setAuthSecret] = useState("");
  const [authRemember, setAuthRemember] = useState(false);
  const opIdRef = useRef<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<{ paths: string[]; untracked: string[] } | null>(null);
  const commitMessageRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grows the commit box with its content up to 300px (VS Code's own
  // commit box behavior) — same measure/clamp-to-scrollHeight approach as
  // csv-preview's formula bar. Runs on every keystroke since a plain CSS
  // height can't track content; resize is disabled below so the two don't
  // fight each other.
  useLayoutEffect(() => {
    const el = commitMessageRef.current;
    if (!el) return;
    el.style.height = "auto";
    const h = Math.min(el.scrollHeight, 300);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > 300 ? "auto" : "hidden";
  }, [message]);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [clickAction, setClickAction] = useState(readClickAction);
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(readCollapsedDirs);
  // Bumped by onDidChangeIconTheme so FileRow/DirRow re-resolve icons after
  // the active icon theme finishes loading or changes in Settings — the
  // resolved IconResult itself isn't kept in state (getFileIcon/getFolderIcon
  // are called fresh on every render), this just forces that re-render.
  const [, setIconVersion] = useState(0);
  // Multi-selection is confined to one status group at a time (Merge
  // Changes / Staged Changes / Changes) — every bulk action is group-
  // specific, so a cross-group selection has no coherent action. A
  // selection gesture in a different group clears and restarts there (see
  // handleRowClick, below). anchorPath is the Shift+click range pivot,
  // reset whenever the selection changes group or is cleared.
  const [selectedGroup, setSelectedGroup] = useState<GroupKey | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [anchorPath, setAnchorPath] = useState<string | null>(null);

  const clearSelection = useCallback(() => {
    setSelectedGroup(null);
    setSelectedPaths(new Set());
    setAnchorPath(null);
  }, []);

  // Rubber-band drag-to-select over ".git-groups" — same gesture as
  // FileTree.tsx, via the shared _shared/useMarqueeSelection copy. Row ids
  // are "<group><KEY_SEP><path>" (decoded below) since selection here is
  // per-group; the marquee constrains to whichever group the *topmost*
  // intersected row belongs to (rows come back from getRows() in DOM
  // order, so decoded[0] is topmost) — an additive (Ctrl/Cmd-held) drag
  // only unions with the pre-drag selection when that selection was
  // already in the same group, otherwise it replaces, consistent with
  // handleRowClick's own single-group rule below.
  const gitGroupsRef = useRef<HTMLDivElement>(null);
  const marqueeSnapshotRef = useRef<{ group: GroupKey | null; paths: Set<string> }>({
    group: null,
    paths: new Set(),
  });
  const { marqueeRect, onMarqueeMouseDown } = useMarqueeSelection({
    containerRef: gitGroupsRef,
    getRows: () => {
      const container = gitGroupsRef.current;
      if (!container) return [];
      return Array.from(container.querySelectorAll<HTMLElement>("[data-path]")).map((el) => ({
        id: `${el.dataset.group}${KEY_SEP}${el.dataset.path}`,
        el,
      }));
    },
    onStart: () => {
      marqueeSnapshotRef.current = { group: selectedGroup, paths: selectedPaths };
    },
    onMarquee: (ids, additive) => {
      const decoded = ids.map((id) => {
        const [group, path] = id.split(KEY_SEP) as [GroupKey, string];
        return { group, path };
      });
      if (decoded.length === 0) {
        if (additive) {
          setSelectedGroup(marqueeSnapshotRef.current.group);
          setSelectedPaths(new Set(marqueeSnapshotRef.current.paths));
        } else {
          setSelectedGroup(null);
          setSelectedPaths(new Set());
        }
        return;
      }
      const topGroup = decoded[0].group;
      const paths = decoded.filter((d) => d.group === topGroup).map((d) => d.path);
      const unionWithSnapshot = additive && marqueeSnapshotRef.current.group === topGroup;
      setSelectedGroup(topGroup);
      setSelectedPaths(unionWithSnapshot ? new Set([...marqueeSnapshotRef.current.paths, ...paths]) : new Set(paths));
    },
    onEnd: (canceled, nearestId) => {
      if (canceled) {
        setSelectedGroup(marqueeSnapshotRef.current.group);
        setSelectedPaths(new Set(marqueeSnapshotRef.current.paths));
        return;
      }
      if (nearestId) {
        const [, path] = nearestId.split(KEY_SEP);
        setAnchorPath(path);
      }
    },
  });

  // onDidChangeContext fires on every sessions poll tick, not just on an
  // actual cwd change — the host derives ActiveContext.windowIndex from a
  // freshly-rebuilt session list each poll, so the callback re-fires with a
  // referentially-new (but value-identical) ctx object even when nothing
  // moved. Tracking the last-seen cwd in a ref (rather than comparing
  // against the `activeCwd` state, which wouldn't yet reflect this same
  // callback's own setActiveCwd call) keeps clearSelection scoped to real
  // directory changes instead of wiping an in-progress selection every ~3s.
  const lastCwdRef = useRef(activeCwd);
  useEffect(() => {
    return onDidChangeContext?.((ctx) => {
      setActiveCwd(ctx.cwd);
      if (ctx.cwd !== lastCwdRef.current) {
        lastCwdRef.current = ctx.cwd;
        clearSelection();
      }
    });
  }, [clearSelection]);
  useEffect(() => extSettings?.onDidChange(() => setClickAction(readClickAction())), []);
  useEffect(() => onDidChangeIconTheme?.(() => setIconVersion((v) => v + 1)), []);
  // Prunes selection entries that no longer exist in their group after a
  // status refresh (staged/committed/discarded out from under the
  // selection elsewhere — another tab, the CLI, a background pull).
  useEffect(() => {
    if (!selectedGroup) return;
    const entries =
      selectedGroup === "conflicted" ? status?.conflicted : selectedGroup === "staged" ? status?.staged : status?.unstaged;
    const validPaths = new Set((entries ?? []).map((e) => e.path));
    setSelectedPaths((prev) => {
      const pruned = new Set([...prev].filter((p) => validPaths.has(p)));
      return pruned.size === prev.size ? prev : pruned;
    });
  }, [status, selectedGroup]);
  // Escape clears the selection. A window-level listener rather than a
  // focus-dependent one on the row/group elements — file rows aren't
  // otherwise part of a keyboard-navigable tree here (unlike FileTree.tsx),
  // so there's no reliable focus target to hang onKeyDown off of. Scoped to
  // only attach while a selection exists, and doesn't preventDefault/
  // stopPropagation, so it can't interfere with Escape handlers elsewhere
  // (e.g. the credential-prompt form's own Escape-to-cancel).
  useEffect(() => {
    if (selectedPaths.size === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedPaths.size, clearSelection]);

  const changeViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    writeViewMode(mode);
  };

  // Toggles one dir's collapsed state and persists it, pruning any keys
  // under the current repo root that no longer correspond to a currently
  // rendered dir node (files got staged/unstaged/discarded out from under
  // them) — `validKeysForRepo` is every "${repoRoot}:${group}:${dirPath}"
  // key derivable from the three groups' trees as rendered right now. Keys
  // for other repo roots are left untouched — this repo's tree can't
  // validate them.
  const toggleDir = (key: string, validKeysForRepo: Set<string>, repoRoot: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      const pruned = new Set(
        [...next].filter((k) => !k.startsWith(`${repoRoot}:`) || validKeysForRepo.has(k)),
      );
      writeCollapsedDirs(pruned);
      return pruned;
    });
  };

  // Prefills the commit box from .git/MERGE_MSG once per operation "start"
  // (tracked via the ref, which resets when the operation clears) rather
  // than on every status poll — otherwise it would stomp on whatever the
  // user is typing every few seconds. Only fires into an empty box, so a
  // message the user already started stays untouched. `message` is
  // deliberately left out of the dependency array: this effect should react
  // to the operation changing, not to the user's own typing.
  const prefilledOpRef = useRef<OperationKind | null>(null);
  useEffect(() => {
    const op = status?.operation ?? null;
    if (!op) {
      prefilledOpRef.current = null;
      return;
    }
    if (prefilledOpRef.current === op) return;
    prefilledOpRef.current = op;
    if (!message.trim() && status?.mergeMsg) {
      setMessage(status.mergeMsg.replace(/\n+$/, ""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.operation, status?.mergeMsg]);

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
  const abortOperation = () => runOp(() => apiPost("/abort", { cwd: activeCwd }));

  const clearAuthForm = useCallback(() => {
    setAuthPrompt(null);
    setAuthUsername("");
    setAuthSecret("");
    setAuthRemember(false);
  }, []);

  const runNetwork = useCallback(
    (kind: NetworkKind) => {
      const opId = crypto.randomUUID();
      opIdRef.current = opId;
      // 300ms keeps a relayed prompt visible ≤ ~350ms after git asks (the
      // plan's stated latency budget); polling only runs while this op's
      // request is in flight.
      const pollTimer = window.setInterval(async () => {
        if (opIdRef.current !== opId) return;
        try {
          const data = await apiGetJson<{ prompt: AuthPrompt | null }>(`/prompt?op=${opId}`);
          if (opIdRef.current !== opId) return;
          setAuthPrompt((cur) => (cur?.id === data.prompt?.id ? cur : data.prompt));
        } catch {
          // Transient poll failure — the op request itself surfaces errors.
        }
      }, 300);
      return runOp(async () => {
        try {
          await apiPost(`/${kind}`, { cwd: activeCwd, opId });
        } catch (err) {
          // The user declining a prompt isn't an error worth displaying.
          if (err instanceof ApiError && err.cancelled) return;
          throw err;
        } finally {
          window.clearInterval(pollTimer);
          if (opIdRef.current === opId) opIdRef.current = null;
          clearAuthForm();
        }
      });
    },
    [activeCwd, runOp, clearAuthForm],
  );

  // Fire-and-forget: the reply's outcome surfaces through the still-open
  // network-op request, not this call.
  const replyPrompt = (body: Record<string, unknown>) => {
    if (!authPrompt || !opIdRef.current) return;
    const payload = { op: opIdRef.current, id: authPrompt.id, ...body };
    clearAuthForm();
    apiPost("/prompt-reply", payload).catch(() => {});
  };

  const submitPrompt = () => {
    if (!authPrompt) return;
    if (authPrompt.kind === "username") {
      replyPrompt({ username: authUsername, password: authSecret, remember: authRemember });
    } else {
      replyPrompt({ answer: authSecret });
    }
  };

  const cancelPrompt = () => replyPrompt({ cancel: true });

  // Explicit, clickAction-independent opens — used directly by the context
  // menu (whose items name the action outright) and composed by openEntry
  // below (whose click-driven default/secondary pair is clickAction-
  // relative). All three no-op without an active directory.
  const openDiff = (entry: FileEntry, staged: boolean) => {
    if (!activeCwd) return;
    const untracked = entry.status === "untracked";
    const key = encodeDiffKey(activeCwd, entry.path, staged, untracked, entry.origPath);
    const title = `${basenameOf(entry.path)} (${staged ? "Staged" : "Working Tree"})`;
    openViewerTab?.("diff", key, { title });
  };
  const openInEditor = (entry: FileEntry) => {
    if (!activeCwd) return;
    openFileTab?.(`${activeCwd}/${entry.path}`);
  };
  const openConflictResolver = (entry: FileEntry) => {
    if (!activeCwd) return;
    const key = encodeConflictKey(activeCwd, entry.path);
    openViewerTab?.("conflict", key, { title: `${basenameOf(entry.path)} (Merge)` });
  };

  // Shift+click always opens the OTHER action from gitScm.clickAction's
  // configured default — same escape-hatch convention the host uses for
  // preview vs. edit (QuickSwitcher's Shift+Enter/Shift+click, FileTree's
  // hover icon). Conflicted entries are the one exception: there's no diff
  // to show (both sides are live conflict markers in the working tree, not
  // two commits to compare), so a click opens the ConflictView resolver
  // instead, ignoring gitScm.clickAction — Shift+click is still the escape
  // hatch straight to nvim, same as every other row.
  const openEntry = (entry: FileEntry, staged: boolean, secondary: boolean) => {
    if (entry.status === "conflicted") {
      if (secondary) openInEditor(entry);
      else openConflictResolver(entry);
      return;
    }
    const wantsEdit = secondary ? clickAction !== "edit" : clickAction === "edit";
    if (wantsEdit) openInEditor(entry);
    else openDiff(entry, staged);
  };

  // ---- Multi-selection (Ctrl/Cmd+click toggle, Shift+click range/quick-
  // action, Ctrl+Shift+click secondary escape hatch — same precedence as
  // FileTree.tsx's handleRowClick) ----

  // Every file entry in a group, in the order it's actually rendered right
  // now — list mode is just that group's flat array; tree mode walks the
  // tree depth-first, skipping collapsed dirs, since a row hidden by
  // collapse isn't a valid range-select endpoint. Used both for Shift+click
  // range math and for resolving a bulk selection's entries.
  const visibleFileEntries = (groupKey: GroupKey): FileEntry[] => {
    if (viewMode === "list") {
      return groupKey === "conflicted" ? conflicted : groupKey === "staged" ? staged : unstaged;
    }
    const tree = groupKey === "conflicted" ? conflictedTree : groupKey === "staged" ? stagedTree : unstagedTree;
    const keyPrefix = `${repoRoot}:${groupKey}`;
    const out: FileEntry[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === "dir") {
          if (!collapsedDirs.has(`${keyPrefix}:${node.path}`)) walk(node.children);
        } else {
          out.push(node.entry);
        }
      }
    };
    walk(tree);
    return out;
  };

  const selectRange = (groupKey: GroupKey, fromPath: string, toPath: string) => {
    const entries = visibleFileEntries(groupKey);
    const lo = entries.findIndex((e) => e.path === fromPath);
    const hi = entries.findIndex((e) => e.path === toPath);
    setSelectedGroup(groupKey);
    if (lo === -1 || hi === -1) {
      // Anchor fell out of the visible set (pruned by a status change, or
      // collapsed behind a dir) — fall back to selecting just the clicked row.
      setSelectedPaths(new Set([toPath]));
      return;
    }
    const [start, end] = lo <= hi ? [lo, hi] : [hi, lo];
    setSelectedPaths(new Set(entries.slice(start, end + 1).map((e) => e.path)));
  };

  // What a row's hover action (Stage/Unstage/Discard) should apply to: the
  // whole selection when this row is part of one (2+), otherwise just
  // itself — VS Code SCM's "act on the row you clicked, or the selection if
  // it's in one" convention.
  const groupSelectedEntries = (groupKey: GroupKey, entry: FileEntry): FileEntry[] => {
    if (selectedGroup === groupKey && selectedPaths.has(entry.path) && selectedPaths.size > 1) {
      return visibleFileEntries(groupKey).filter((e) => selectedPaths.has(e.path));
    }
    return [entry];
  };

  // What a group header's "All" actions (Stage All / Unstage All / Discard
  // All) apply to: the group's active selection if it has one (any size —
  // even a single selected file scopes the header buttons to just that
  // file), otherwise every entry in the group, unchanged from before multi-
  // select existed.
  const groupTargetEntries = (groupKey: GroupKey, allEntries: FileEntry[]): FileEntry[] =>
    selectedGroup === groupKey && selectedPaths.size > 0
      ? allEntries.filter((e) => selectedPaths.has(e.path))
      : allEntries;

  // Checked in this order: Ctrl/Cmd+Shift+click is the secondary-open
  // escape hatch, collapsing selection to this row first — mirrors
  // FileTree.tsx's handling of the same combo. Then Ctrl/Cmd+click alone
  // toggles the row into the selection (starting fresh if the current
  // selection lives in a different group — selection never spans groups,
  // since every bulk action is group-specific). Then Shift+click: with no
  // selection active in this group it's the ordinary secondary-action click
  // (unchanged from before multi-select existed); with one active it range-
  // selects from the anchor. Otherwise a plain click selects just this row
  // and opens it, same as FileTree.
  const handleRowClick = (groupKey: GroupKey, entry: FileEntry, staged: boolean, e: ReactMouseEvent) => {
    const ctrlOrCmd = e.ctrlKey || e.metaKey;
    const inGroup = selectedGroup === groupKey;
    if (ctrlOrCmd && e.shiftKey) {
      setSelectedGroup(groupKey);
      setSelectedPaths(new Set([entry.path]));
      setAnchorPath(entry.path);
      openEntry(entry, staged, true);
      return;
    }
    if (ctrlOrCmd) {
      if (inGroup) {
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          return next;
        });
      } else {
        setSelectedGroup(groupKey);
        setSelectedPaths(new Set([entry.path]));
      }
      setAnchorPath(entry.path);
      return;
    }
    if (e.shiftKey) {
      if (!inGroup || selectedPaths.size === 0) {
        openEntry(entry, staged, true);
        return;
      }
      selectRange(groupKey, anchorPath ?? entry.path, entry.path);
      return;
    }
    setSelectedGroup(groupKey);
    setSelectedPaths(new Set([entry.path]));
    setAnchorPath(entry.path);
    openEntry(entry, staged, false);
  };

  const buildFileMenuItems = (groupKey: GroupKey, entry: FileEntry, staged: boolean): MenuItem[] => {
    if (entry.status === "conflicted") {
      return [
        { label: "Resolve in Merge Editor", onClick: () => openConflictResolver(entry) },
        { label: "Open in Editor", onClick: () => openInEditor(entry) },
        { label: "Stage Changes", onClick: () => stage([entry.path]) },
      ];
    }
    const items: MenuItem[] = [
      { label: "Open Diff", onClick: () => openDiff(entry, staged) },
      { label: "Open in Editor", onClick: () => openInEditor(entry) },
    ];
    if (groupKey === "staged") {
      items.push({ label: "Unstage Changes", onClick: () => unstage([entry.path]) });
    } else {
      items.push({ label: "Stage Changes", onClick: () => stage([entry.path]) });
      items.push({
        label: "Discard Changes",
        danger: true,
        onClick: () =>
          setConfirmDiscard({ paths: [entry.path], untracked: entry.status === "untracked" ? [entry.path] : [] }),
      });
    }
    return items;
  };

  const buildBulkMenuItems = (groupKey: GroupKey, entries: FileEntry[]): MenuItem[] => {
    const n = entries.length;
    const paths = entries.map((e) => e.path);
    if (groupKey === "conflicted") {
      return [{ label: `Stage ${n} Changes`, onClick: () => stage(paths) }];
    }
    if (groupKey === "staged") {
      return [{ label: `Unstage ${n} Changes`, onClick: () => unstage(paths) }];
    }
    const untracked = entries.filter((e) => e.status === "untracked").map((e) => e.path);
    return [
      { label: `Stage ${n} Changes`, onClick: () => stage(paths) },
      { label: `Discard ${n} Changes`, danger: true, onClick: () => setConfirmDiscard({ paths, untracked }) },
    ];
  };

  // Right-clicking a row that's part of a live multi-selection (2+) shows
  // the bulk menu for the whole selection; right-clicking anything else
  // (an unselected row, or a lone selected row) collapses selection to just
  // that row first, matching FileTree.tsx's handleRowContextMenu.
  const handleRowContextMenu = (groupKey: GroupKey, entry: FileEntry, staged: boolean, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const inGroup = selectedGroup === groupKey;
    if (inGroup && selectedPaths.has(entry.path) && selectedPaths.size > 1) {
      const entries = visibleFileEntries(groupKey).filter((en) => selectedPaths.has(en.path));
      showMenu?.(e.clientX, e.clientY, buildBulkMenuItems(groupKey, entries));
      return;
    }
    setSelectedGroup(groupKey);
    setSelectedPaths(new Set([entry.path]));
    setAnchorPath(entry.path);
    showMenu?.(e.clientX, e.clientY, buildFileMenuItems(groupKey, entry, staged));
  };

  // ---- Tree mode (hoisted above the early returns below — useListNavigation
  // needs these, and hooks can't follow a conditional return) ----
  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];
  const conflicted = status?.conflicted ?? [];
  const repoRoot = status?.root ?? "";
  const conflictedTree = viewMode === "tree" ? buildTree(conflicted) : [];
  const stagedTree = viewMode === "tree" ? buildTree(staged) : [];
  const unstagedTree = viewMode === "tree" ? buildTree(unstaged) : [];

  // Every collapse key any of the three trees could currently produce —
  // used to prune stale keys for this repo root when any dir is toggled
  // (see toggleDir).
  const validKeysForRepo = new Set<string>();
  if (viewMode === "tree") {
    collectDirKeys(`${repoRoot}:conflicted`, conflictedTree, validKeysForRepo);
    collectDirKeys(`${repoRoot}:staged`, stagedTree, validKeysForRepo);
    collectDirKeys(`${repoRoot}:unstaged`, unstagedTree, validKeysForRepo);
  }

  // ---- Keyboard navigation (roving tabindex across all three groups) ----
  // One flattened row list per group — header, then its dir/file rows in
  // exactly the order renderTreeGroup (tree mode) or the plain .map (list
  // mode) below renders them, so ids assigned here line up with the
  // getRowProps() calls threaded into the JSX further down. Group headers
  // ARE focus stops (unlike file/dir rows' plain click, Enter/Space on a
  // header is a no-op — see navOnActivate); dir rows aren't part of file
  // selection (matching DirRow's mouse onClick, which only toggles).
  type NavRow =
    | { kind: "header"; id: string; groupKey: GroupKey }
    | { kind: "dir"; id: string; groupKey: GroupKey; node: TreeDirNode }
    | { kind: "file"; id: string; groupKey: GroupKey; entry: FileEntry };

  const buildGroupNavRows = (groupKey: GroupKey, flatEntries: FileEntry[], tree: TreeNode[]): NavRow[] => {
    if (flatEntries.length === 0) return [];
    const out: NavRow[] = [{ kind: "header", id: `header:${groupKey}`, groupKey }];
    if (viewMode === "list") {
      for (const entry of flatEntries) out.push({ kind: "file", id: `file:${groupKey}:${entry.path}`, groupKey, entry });
      return out;
    }
    const keyPrefix = `${repoRoot}:${groupKey}`;
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === "dir") {
          out.push({ kind: "dir", id: `dir:${groupKey}:${node.path}`, groupKey, node });
          if (!collapsedDirs.has(`${keyPrefix}:${node.path}`)) walk(node.children);
        } else {
          out.push({ kind: "file", id: `file:${groupKey}:${node.entry.path}`, groupKey, entry: node.entry });
        }
      }
    };
    walk(tree);
    return out;
  };

  const navRows = [
    ...buildGroupNavRows("conflicted", conflicted, conflictedTree),
    ...buildGroupNavRows("staged", staged, stagedTree),
    ...buildGroupNavRows("unstaged", unstaged, unstagedTree),
  ];
  const navRowsById = new Map(navRows.map((r) => [r.id, r]));
  const navRowIds = navRows.map((r) => r.id);

  const resultNav = useListNavigation({
    rowIds: navRowIds,
    onActivate: (id) => {
      const row = navRowsById.get(id);
      if (!row || row.kind === "header") return;
      if (row.kind === "dir") {
        toggleDir(`${repoRoot}:${row.groupKey}:${row.node.path}`, validKeysForRepo, repoRoot);
        return;
      }
      setSelectedGroup(row.groupKey);
      setSelectedPaths(new Set([row.entry.path]));
      setAnchorPath(row.entry.path);
      openEntry(row.entry, row.groupKey === "staged", false);
    },
    onExpand: (id) => {
      const row = navRowsById.get(id);
      if (row?.kind !== "dir") return;
      const key = `${repoRoot}:${row.groupKey}:${row.node.path}`;
      if (collapsedDirs.has(key)) toggleDir(key, validKeysForRepo, repoRoot);
    },
    onCollapse: (id) => {
      const row = navRowsById.get(id);
      if (row?.kind !== "dir") return;
      const key = `${repoRoot}:${row.groupKey}:${row.node.path}`;
      if (!collapsedDirs.has(key)) toggleDir(key, validKeysForRepo, repoRoot);
    },
    onFocusChange: (id, { shiftKey }) => {
      const row = navRowsById.get(id);
      if (!row || row.kind !== "file") return;
      if (shiftKey && selectedGroup === row.groupKey && anchorPath) {
        selectRange(row.groupKey, anchorPath, row.entry.path);
        return;
      }
      setSelectedGroup(row.groupKey);
      setSelectedPaths(new Set([row.entry.path]));
      setAnchorPath(row.entry.path);
    },
    onContextMenuKey: (id, rect) => {
      const row = navRowsById.get(id);
      if (!row || row.kind !== "file") return;
      if (selectedGroup === row.groupKey && selectedPaths.has(row.entry.path) && selectedPaths.size > 1) {
        const entries = visibleFileEntries(row.groupKey).filter((en) => selectedPaths.has(en.path));
        showMenu?.(rect.left + 8, rect.bottom, buildBulkMenuItems(row.groupKey, entries));
        return;
      }
      setSelectedGroup(row.groupKey);
      setSelectedPaths(new Set([row.entry.path]));
      setAnchorPath(row.entry.path);
      showMenu?.(rect.left + 8, rect.bottom, buildFileMenuItems(row.groupKey, row.entry, row.groupKey === "staged"));
    },
  });

  if (!activeCwd) {
    return <div className="git-empty">No active directory.</div>;
  }
  if (!status) {
    return <div className="git-empty">Loading…</div>;
  }
  if (!status.root) {
    return <div className="git-empty">Not a git repository.</div>;
  }

  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  const clickHint = `Shift+Click: ${clickAction === "edit" ? "Open Diff" : "Open in Editor"} · Ctrl+Click: Select`;
  const conflictClickHint = "Shift+Click: Open in Editor · Ctrl+Click: Select";
  const operation = status.operation ?? null;

  // Renders one group's tree recursively. `makeFileProps` and `makeDirActions`
  // capture whatever differs per group (openEntry's staged flag, which
  // actions a row/dir gets) — everything else (indentation, collapse
  // toggling, key derivation) is shared.
  function renderTreeGroup(
    groupKey: GroupKey,
    nodes: TreeNode[],
    makeFileProps: (entry: FileEntry) => { staged: boolean; actions: RowAction[]; clickHint?: string },
    makeDirActions: (entries: FileEntry[]) => RowAction[],
    depth = 0,
  ): ReactNode[] {
    const keyPrefix = `${repoRoot}:${groupKey}`;
    const out: ReactNode[] = [];
    for (const node of nodes) {
      if (node.kind === "dir") {
        const key = `${keyPrefix}:${node.path}`;
        const collapsed = collapsedDirs.has(key);
        const dirEntries = collectEntries(node.children);
        const dirRowProps = resultNav.getRowProps(`dir:${groupKey}:${node.path}`);
        out.push(
          <DirRow
            key={key}
            node={node}
            depth={depth}
            collapsed={collapsed}
            onToggle={() => toggleDir(key, validKeysForRepo, repoRoot)}
            actions={makeDirActions(dirEntries)}
            tabIndex={dirRowProps.tabIndex}
            rowRef={dirRowProps.ref}
            onRowFocus={dirRowProps.onFocus}
          />,
        );
        if (!collapsed) {
          out.push(...renderTreeGroup(groupKey, node.children, makeFileProps, makeDirActions, depth + 1));
        }
      } else {
        const { staged, actions, clickHint: rowHint } = makeFileProps(node.entry);
        const fileRowProps = resultNav.getRowProps(`file:${groupKey}:${node.entry.path}`);
        out.push(
          <FileRow
            key={node.entry.path}
            entry={node.entry}
            group={groupKey}
            selected={selectedGroup === groupKey && selectedPaths.has(node.entry.path)}
            onRowClick={(e) => handleRowClick(groupKey, node.entry, staged, e)}
            onRowContextMenu={(e) => handleRowContextMenu(groupKey, node.entry, staged, e)}
            actions={actions}
            clickHint={rowHint}
            depth={depth}
            hideDir
            tabIndex={fileRowProps.tabIndex}
            rowRef={fileRowProps.ref}
            onRowFocus={fileRowProps.onFocus}
          />,
        );
      }
    }
    return out;
  }

  const conflictedHeaderRowProps = resultNav.getRowProps("header:conflicted");
  const stagedHeaderRowProps = resultNav.getRowProps("header:staged");
  const unstagedHeaderRowProps = resultNav.getRowProps("header:unstaged");

  const headerActions = (
    <>
      <button
        className={`icon-button mode-button${viewMode === "list" ? " active" : ""}`}
        title="View as List"
        onClick={() => changeViewMode("list")}
      >
        <Icon name="list-flat" />
      </button>
      <button
        className={`icon-button mode-button${viewMode === "tree" ? " active" : ""}`}
        title="View as Tree"
        onClick={() => changeViewMode("tree")}
      >
        <Icon name="list-tree" />
      </button>
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

      {operation && (
        <div className="git-merge-banner">
          <Icon name="git-merge" />
          <span className="git-merge-banner-text">{OPERATION_LABEL[operation]} in progress</span>
          <button className="git-merge-abort-button" disabled={busy} onClick={() => setConfirmAbort(true)}>
            Abort
          </button>
        </div>
      )}

      <div className="git-commit-box">
        <textarea
          ref={commitMessageRef}
          className="git-commit-message"
          placeholder={`Message (${status.branch ?? "detached HEAD"})`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={busy}
          rows={1}
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

      {authPrompt && (
        <div className="git-credential-form">
          <div className="git-auth-prompt-text">{authPrompt.prompt}</div>
          {authPrompt.kind === "hostkey" ? (
            <div className="git-credential-buttons">
              <button className="git-credential-cancel" onClick={cancelPrompt}>
                Cancel
              </button>
              <button className="git-credential-submit" onClick={() => replyPrompt({ answer: "yes" })}>
                Connect
              </button>
            </div>
          ) : (
            <>
              {authPrompt.kind === "username" && (
                <input
                  className="git-credential-input"
                  placeholder="Username"
                  value={authUsername}
                  onChange={(e) => setAuthUsername(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancelPrompt();
                  }}
                />
              )}
              <input
                className="git-credential-input"
                placeholder={
                  authPrompt.kind === "passphrase"
                    ? "Passphrase"
                    : authPrompt.kind === "generic"
                      ? "Answer"
                      : "Password / token"
                }
                type={authPrompt.kind === "generic" ? "text" : "password"}
                value={authSecret}
                onChange={(e) => setAuthSecret(e.target.value)}
                autoFocus={authPrompt.kind !== "username"}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitPrompt();
                  if (e.key === "Escape") cancelPrompt();
                }}
              />
              {authPrompt.kind === "username" && (
                <label className="git-auth-remember">
                  <input
                    type="checkbox"
                    checked={authRemember}
                    onChange={(e) => setAuthRemember(e.target.checked)}
                  />
                  Remember credentials
                </label>
              )}
              <div className="git-credential-buttons">
                <button className="git-credential-cancel" onClick={cancelPrompt}>
                  Cancel
                </button>
                <button
                  className="git-credential-submit"
                  onClick={submitPrompt}
                  disabled={authPrompt.kind === "username" ? !authUsername : !authSecret}
                >
                  OK
                </button>
              </div>
            </>
          )}
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

      {confirmAbort && operation && (
        <div className="git-confirm">
          <div className="git-confirm-text">
            Abort the {OPERATION_LABEL[operation].toLowerCase()}? This discards any conflict resolutions made so far.
          </div>
          <div className="git-confirm-buttons">
            <button className="git-credential-cancel" onClick={() => setConfirmAbort(false)}>
              Cancel
            </button>
            <button
              className="git-confirm-discard"
              onClick={() => {
                abortOperation();
                setConfirmAbort(false);
              }}
            >
              Abort
            </button>
          </div>
        </div>
      )}

      <div
        ref={gitGroupsRef}
        className="git-groups"
        onClick={(e) => e.target === e.currentTarget && clearSelection()}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest(".git-row, .git-group-header, button, input, textarea")) return;
          onMarqueeMouseDown(e);
        }}
        onKeyDown={resultNav.onKeyDown}
      >
        {marqueeRect && (
          <div
            className="marquee-rect"
            style={{ left: marqueeRect.left, top: marqueeRect.top, width: marqueeRect.width, height: marqueeRect.height }}
          />
        )}
        {conflicted.length > 0 && (
          <div className="git-group">
            <GroupHeader
              title="Merge Changes"
              count={conflicted.length}
              actions={(() => {
                const target = groupTargetEntries("conflicted", conflicted);
                const isSelection = target.length !== conflicted.length;
                return [
                  {
                    icon: "add",
                    title: isSelection ? `Stage ${target.length} Selected` : "Stage All Changes",
                    onClick: () => stage(target.map((e) => e.path)),
                  },
                ];
              })()}
              tabIndex={conflictedHeaderRowProps.tabIndex}
              rowRef={conflictedHeaderRowProps.ref}
              onRowFocus={conflictedHeaderRowProps.onFocus}
            />
            {viewMode === "tree"
              ? renderTreeGroup(
                  "conflicted",
                  conflictedTree,
                  (entry) => {
                    const sel = groupSelectedEntries("conflicted", entry);
                    return {
                      staged: false,
                      clickHint: conflictClickHint,
                      actions: [
                        {
                          icon: "add",
                          title: sel.length > 1 ? `Stage ${sel.length} Changes` : "Stage Changes",
                          onClick: () => stage(sel.map((e) => e.path)),
                        },
                      ],
                    };
                  },
                  (entries) => [
                    { icon: "add", title: "Stage Changes", onClick: () => stage(entries.map((e) => e.path)) },
                  ],
                )
              : conflicted.map((entry) => {
                  const sel = groupSelectedEntries("conflicted", entry);
                  const fileRowProps = resultNav.getRowProps(`file:conflicted:${entry.path}`);
                  return (
                    <FileRow
                      key={entry.path}
                      entry={entry}
                      group="conflicted"
                      selected={selectedGroup === "conflicted" && selectedPaths.has(entry.path)}
                      onRowClick={(e) => handleRowClick("conflicted", entry, false, e)}
                      onRowContextMenu={(e) => handleRowContextMenu("conflicted", entry, false, e)}
                      clickHint={conflictClickHint}
                      actions={[
                        {
                          icon: "add",
                          title: sel.length > 1 ? `Stage ${sel.length} Changes` : "Stage Changes",
                          onClick: () => stage(sel.map((e) => e.path)),
                        },
                      ]}
                      tabIndex={fileRowProps.tabIndex}
                      rowRef={fileRowProps.ref}
                      onRowFocus={fileRowProps.onFocus}
                    />
                  );
                })}
          </div>
        )}

        {staged.length > 0 && (
          <div className="git-group">
            <GroupHeader
              title="Staged Changes"
              count={staged.length}
              actions={(() => {
                const target = groupTargetEntries("staged", staged);
                const isSelection = target.length !== staged.length;
                return [
                  {
                    icon: "remove",
                    title: isSelection ? `Unstage ${target.length} Selected` : "Unstage All Changes",
                    onClick: () => unstage(target.map((e) => e.path)),
                  },
                ];
              })()}
              tabIndex={stagedHeaderRowProps.tabIndex}
              rowRef={stagedHeaderRowProps.ref}
              onRowFocus={stagedHeaderRowProps.onFocus}
            />
            {viewMode === "tree"
              ? renderTreeGroup(
                  "staged",
                  stagedTree,
                  (entry) => {
                    const sel = groupSelectedEntries("staged", entry);
                    return {
                      staged: true,
                      clickHint,
                      actions: [
                        {
                          icon: "remove",
                          title: sel.length > 1 ? `Unstage ${sel.length} Changes` : "Unstage Changes",
                          onClick: () => unstage(sel.map((e) => e.path)),
                        },
                      ],
                    };
                  },
                  (entries) => [
                    { icon: "remove", title: "Unstage Changes", onClick: () => unstage(entries.map((e) => e.path)) },
                  ],
                )
              : staged.map((entry) => {
                  const sel = groupSelectedEntries("staged", entry);
                  const fileRowProps = resultNav.getRowProps(`file:staged:${entry.path}`);
                  return (
                    <FileRow
                      key={entry.path}
                      entry={entry}
                      group="staged"
                      selected={selectedGroup === "staged" && selectedPaths.has(entry.path)}
                      onRowClick={(e) => handleRowClick("staged", entry, true, e)}
                      onRowContextMenu={(e) => handleRowContextMenu("staged", entry, true, e)}
                      clickHint={clickHint}
                      actions={[
                        {
                          icon: "remove",
                          title: sel.length > 1 ? `Unstage ${sel.length} Changes` : "Unstage Changes",
                          onClick: () => unstage(sel.map((e) => e.path)),
                        },
                      ]}
                      tabIndex={fileRowProps.tabIndex}
                      rowRef={fileRowProps.ref}
                      onRowFocus={fileRowProps.onFocus}
                    />
                  );
                })}
          </div>
        )}

        {unstaged.length > 0 && (
          <div className="git-group">
            <GroupHeader
              title="Changes"
              count={unstaged.length}
              actions={(() => {
                const target = groupTargetEntries("unstaged", unstaged);
                const isSelection = target.length !== unstaged.length;
                const targetUntracked = target.filter((e) => e.status === "untracked").map((e) => e.path);
                return [
                  {
                    icon: "add",
                    title: isSelection ? `Stage ${target.length} Selected` : "Stage All Changes",
                    onClick: () => stage(target.map((e) => e.path)),
                  },
                  {
                    icon: "discard",
                    title: isSelection ? `Discard ${target.length} Selected` : "Discard All Changes",
                    onClick: () =>
                      setConfirmDiscard({ paths: target.map((e) => e.path), untracked: targetUntracked }),
                  },
                ];
              })()}
              tabIndex={unstagedHeaderRowProps.tabIndex}
              rowRef={unstagedHeaderRowProps.ref}
              onRowFocus={unstagedHeaderRowProps.onFocus}
            />
            {viewMode === "tree"
              ? renderTreeGroup(
                  "unstaged",
                  unstagedTree,
                  (entry) => {
                    const sel = groupSelectedEntries("unstaged", entry);
                    const untracked = sel.filter((e) => e.status === "untracked").map((e) => e.path);
                    return {
                      staged: false,
                      clickHint,
                      actions: [
                        {
                          icon: "discard",
                          title: sel.length > 1 ? `Discard ${sel.length} Changes` : "Discard Changes",
                          onClick: () => setConfirmDiscard({ paths: sel.map((e) => e.path), untracked }),
                        },
                        {
                          icon: "add",
                          title: sel.length > 1 ? `Stage ${sel.length} Changes` : "Stage Changes",
                          onClick: () => stage(sel.map((e) => e.path)),
                        },
                      ],
                    };
                  },
                  (entries) => [
                    {
                      icon: "discard",
                      title: "Discard Changes",
                      onClick: () =>
                        setConfirmDiscard({
                          paths: entries.map((e) => e.path),
                          untracked: entries.filter((e) => e.status === "untracked").map((e) => e.path),
                        }),
                    },
                    { icon: "add", title: "Stage Changes", onClick: () => stage(entries.map((e) => e.path)) },
                  ],
                )
              : unstaged.map((entry) => {
                  const sel = groupSelectedEntries("unstaged", entry);
                  const untracked = sel.filter((e) => e.status === "untracked").map((e) => e.path);
                  const fileRowProps = resultNav.getRowProps(`file:unstaged:${entry.path}`);
                  return (
                    <FileRow
                      key={entry.path}
                      entry={entry}
                      group="unstaged"
                      selected={selectedGroup === "unstaged" && selectedPaths.has(entry.path)}
                      onRowClick={(e) => handleRowClick("unstaged", entry, false, e)}
                      onRowContextMenu={(e) => handleRowContextMenu("unstaged", entry, false, e)}
                      clickHint={clickHint}
                      actions={[
                        {
                          icon: "discard",
                          title: sel.length > 1 ? `Discard ${sel.length} Changes` : "Discard Changes",
                          onClick: () => setConfirmDiscard({ paths: sel.map((e) => e.path), untracked }),
                        },
                        {
                          icon: "add",
                          title: sel.length > 1 ? `Stage ${sel.length} Changes` : "Stage Changes",
                          onClick: () => stage(sel.map((e) => e.path)),
                        },
                      ]}
                      tabIndex={fileRowProps.tabIndex}
                      rowRef={fileRowProps.ref}
                      onRowFocus={fileRowProps.onFocus}
                    />
                  );
                })}
          </div>
        )}

        {staged.length === 0 && unstaged.length === 0 && conflicted.length === 0 && (
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

// ---- Conflict marker parsing ----
// Splits a working-tree file's lines into alternating plain-text runs and
// conflict blocks, keyed by line range in `lines` so a resolution can splice
// the original array rather than reconstructing untouched text byte-for-
// byte. Handles both the default 2-way marker set and the diff3/zdiff3
// 3-way set (an extra "||||||| <base label>" section) — see git's
// merge.conflictStyle setting.

interface ConflictBlock {
  kind: "conflict";
  start: number; // index of the "<<<<<<<" line
  end: number; // index of the ">>>>>>>" line (inclusive)
  oursLabel: string;
  theirsLabel: string;
  ours: string[];
  base?: string[];
  baseLabel?: string;
  theirs: string[];
}

interface TextRun {
  kind: "text";
  start: number;
  end: number; // inclusive
}

type ConflictSegment = ConflictBlock | TextRun;

function parseConflictSegments(lines: string[]): ConflictSegment[] {
  const segments: ConflictSegment[] = [];
  let i = 0;
  let textStart = 0;

  const flushText = (end: number) => {
    if (end >= textStart) segments.push({ kind: "text", start: textStart, end });
  };

  while (i < lines.length) {
    if (!lines[i].startsWith("<<<<<<< ")) {
      i++;
      continue;
    }
    const start = i;
    const oursLabel = lines[i].slice("<<<<<<< ".length);
    i++;
    const oursStart = i;
    while (i < lines.length && !lines[i].startsWith("|||||||") && lines[i] !== "=======") i++;
    const ours = lines.slice(oursStart, i);

    let base: string[] | undefined;
    let baseLabel: string | undefined;
    if (i < lines.length && lines[i].startsWith("|||||||")) {
      baseLabel = lines[i].slice("||||||| ".length);
      i++;
      const baseStart = i;
      while (i < lines.length && lines[i] !== "=======") i++;
      base = lines.slice(baseStart, i);
    }

    if (i >= lines.length) {
      // No "=======" found — malformed/unterminated marker. Bail out and
      // let the trailing flushText below cover the rest as plain text
      // rather than guessing at a boundary.
      break;
    }
    i++; // skip "======="

    const theirsStart = i;
    while (i < lines.length && !lines[i].startsWith(">>>>>>> ")) i++;
    if (i >= lines.length) {
      // No closing ">>>>>>>" — same malformed-file bailout as above.
      break;
    }
    const theirs = lines.slice(theirsStart, i);
    const theirsLabel = lines[i].slice(">>>>>>> ".length);
    const end = i;

    flushText(start - 1);
    segments.push({ kind: "conflict", start, end, oursLabel, theirsLabel, ours, base, baseLabel, theirs });
    i = end + 1;
    textStart = i;
  }

  flushText(lines.length - 1);
  return segments;
}

type ResolutionChoice = "ours" | "theirs" | "both";

// ---- ConflictView (registerFileViewer component, extensions: []) ----
// Reached the same way DiffView is — only via ctx.app.openViewerTab, from a
// conflicted row's click (see GitPanel's openEntry). Accept/Undo only touch
// in-memory `resolutions` state — nothing reaches disk until Save is
// clicked, same "buffer, then explicit persist" model CsvView's editable
// grid uses (down to reporting dirty state via setDirty so closing the tab
// mid-edit gets the host's confirm-before-discard prompt). Save writes
// whatever's currently decided (a partial save can still leave some blocks
// unresolved, keeping their markers) via the hash-guarded /resolve endpoint,
// then reloads — any block that got saved is simply gone from the fresh
// parse, since its markers no longer exist on disk. "Mark as Resolved"
// stages the file (git add) and is only enabled once nothing is left
// unresolved AND nothing is pending an unsaved decision.

interface ConflictProps {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  openInEditor?: (path: string) => void;
  setDirty?: (dirty: boolean) => void;
}

interface ConflictFileResponse {
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  hash: string | null;
}

// Keyed by ConflictBlock.start (unique within one load's line numbering,
// and stable across re-renders since `lines`/`segments` don't change until
// a Save triggers a fresh load).
type ResolutionMap = Record<number, ResolutionChoice>;

function buildResolvedContent(lines: string[], segments: ConflictSegment[], resolutions: ResolutionMap): string {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.kind === "text") {
      out.push(...lines.slice(seg.start, seg.end + 1));
      continue;
    }
    const choice = resolutions[seg.start];
    if (!choice) {
      // Still undecided — keep the raw marker block as-is.
      out.push(...lines.slice(seg.start, seg.end + 1));
      continue;
    }
    out.push(...(choice === "ours" ? seg.ours : choice === "theirs" ? seg.theirs : [...seg.ours, ...seg.theirs]));
  }
  return out.join("\n");
}

const CHOICE_LABEL: Record<ResolutionChoice, string> = { ours: "Current", theirs: "Incoming", both: "Both" };

function ConflictView({ filePath, active, toolbarTarget, openInEditor, setDirty }: ConflictProps) {
  const parsed = useMemo(() => decodeConflictKey(filePath), [filePath]);
  const [data, setData] = useState<ConflictFileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolutions, setResolutions] = useState<ResolutionMap>({});

  const load = useCallback(() => {
    setError(null);
    setResolutions({});
    const params = new URLSearchParams({ cwd: parsed.cwd, path: parsed.path });
    apiGetJson<ConflictFileResponse>(`/conflict?${params}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [parsed.cwd, parsed.path]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const lines = useMemo(() => (data?.content != null ? data.content.split("\n") : null), [data]);
  const segments = useMemo(() => (lines ? parseConflictSegments(lines) : null), [lines]);
  const blocks = useMemo(
    () => segments?.filter((s): s is ConflictBlock => s.kind === "conflict") ?? [],
    [segments],
  );
  const remaining = useMemo(() => blocks.filter((b) => !resolutions[b.start]).length, [blocks, resolutions]);
  const dirty = Object.keys(resolutions).length > 0;

  useEffect(() => setDirty?.(dirty), [dirty, setDirty]);

  const acceptBlock = (block: ConflictBlock, choice: ResolutionChoice) => {
    setResolutions((prev) => ({ ...prev, [block.start]: choice }));
  };

  const undoBlock = (block: ConflictBlock) => {
    setResolutions((prev) => {
      const next = { ...prev };
      delete next[block.start];
      return next;
    });
  };

  // Bulk override for every block in the file, including ones already given
  // a different per-block choice — same in-memory-only, Undo-able, Save-to-
  // persist semantics as a single Accept click.
  const acceptAll = (choice: ResolutionChoice) => {
    setResolutions(Object.fromEntries(blocks.map((b) => [b.start, choice])));
  };

  const save = () => {
    if (!lines || !segments || !data?.hash) return;
    const content = buildResolvedContent(lines, segments, resolutions);
    setBusy(true);
    setError(null);
    apiPost("/resolve", { cwd: parsed.cwd, path: parsed.path, content, expectedHash: data.hash })
      .then(load)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const markResolved = () => {
    setBusy(true);
    setError(null);
    apiPost("/stage", { cwd: parsed.cwd, paths: [parsed.path] })
      .then(() => {
        refreshStatus();
        refreshFiles?.();
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const controls = (
    <button
      className="icon-button"
      title="Open in Editor"
      onClick={() => openInEditor?.(`${parsed.cwd}/${parsed.path}`)}
    >
      <Icon name="go-to-file" />
    </button>
  );

  const statusText =
    remaining > 0
      ? `${remaining} conflict${remaining === 1 ? "" : "s"} remaining`
      : dirty
        ? "All conflicts resolved — Save to apply"
        : "All conflicts resolved";

  return (
    <div className={`git-conflict-host${active ? "" : " hidden"}`}>
      {error && <div className="git-diff-status git-diff-error">{error}</div>}
      {!error && data === null && <div className="git-diff-status">Loading…</div>}
      {!error && data?.tooLarge && (
        <div className="git-diff-status">File is too large to resolve here — open in Editor instead.</div>
      )}
      {!error && data?.binary && (
        <div className="git-diff-status">Binary file conflict — resolve in Editor, then Mark as Resolved.</div>
      )}
      {!error && data && !data.binary && !data.tooLarge && segments && (
        <>
          <div className="git-conflict-toolbar">
            <span className="git-conflict-count">{statusText}</span>
            <button
              className="git-conflict-save-button"
              disabled={busy || !dirty}
              title={dirty ? "Save resolved conflicts to disk" : "No unsaved changes"}
              onClick={save}
            >
              <Icon name="save" /> Save
            </button>
            <button
              className="git-conflict-resolve-button"
              disabled={busy || remaining > 0 || dirty}
              title={
                remaining > 0 ? "Resolve all conflicts first" : dirty ? "Save your changes first" : "Stage this file"
              }
              onClick={markResolved}
            >
              <Icon name="check" /> Mark as Resolved
            </button>
          </div>
          {blocks.length > 1 && (
            <div className="git-conflict-toolbar-secondary">
              <span className="git-conflict-accept-all-label">Accept All:</span>
              <button className="git-conflict-accept-all" disabled={busy} onClick={() => acceptAll("ours")}>
                Current
              </button>
              <button className="git-conflict-accept-all" disabled={busy} onClick={() => acceptAll("theirs")}>
                Incoming
              </button>
              <button className="git-conflict-accept-all" disabled={busy} onClick={() => acceptAll("both")}>
                Both
              </button>
            </div>
          )}
          <div className="git-conflict-body">
            {segments.map((seg, i) => {
              if (seg.kind === "text") {
                return (
                  <pre key={i} className="git-conflict-text">
                    {lines!.slice(seg.start, seg.end + 1).join("\n")}
                  </pre>
                );
              }
              const choice = resolutions[seg.start];
              if (choice) {
                const replacement =
                  choice === "ours" ? seg.ours : choice === "theirs" ? seg.theirs : [...seg.ours, ...seg.theirs];
                return (
                  <div key={i} className="git-conflict-block git-conflict-block-resolved">
                    <div className="git-conflict-side-header">
                      <span>Resolved: {CHOICE_LABEL[choice]}</span>
                      <button className="git-conflict-accept" disabled={busy} onClick={() => undoBlock(seg)}>
                        Undo
                      </button>
                    </div>
                    <pre className="git-conflict-side-body">{replacement.join("\n")}</pre>
                  </div>
                );
              }
              return (
                <div key={i} className="git-conflict-block">
                  <div className="git-conflict-side git-conflict-ours">
                    <div className="git-conflict-side-header">
                      <span>Current: {seg.oursLabel}</span>
                      <button className="git-conflict-accept" disabled={busy} onClick={() => acceptBlock(seg, "ours")}>
                        Accept Current
                      </button>
                    </div>
                    <pre className="git-conflict-side-body">{seg.ours.join("\n")}</pre>
                  </div>
                  {seg.base && (
                    <div className="git-conflict-side git-conflict-base">
                      <div className="git-conflict-side-header">
                        <span>Base{seg.baseLabel ? `: ${seg.baseLabel}` : ""}</span>
                      </div>
                      <pre className="git-conflict-side-body">{seg.base.join("\n")}</pre>
                    </div>
                  )}
                  <div className="git-conflict-side git-conflict-theirs">
                    <div className="git-conflict-side-header">
                      <span>Incoming: {seg.theirsLabel}</span>
                      <button
                        className="git-conflict-accept"
                        disabled={busy}
                        onClick={() => acceptBlock(seg, "theirs")}
                      >
                        Accept Incoming
                      </button>
                    </div>
                    <pre className="git-conflict-side-body">{seg.theirs.join("\n")}</pre>
                  </div>
                  <div className="git-conflict-block-footer">
                    <button
                      className="git-conflict-accept-both"
                      disabled={busy}
                      onClick={() => acceptBlock(seg, "both")}
                    >
                      Accept Both
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
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
    focusBinding?: string;
    component: typeof GitPanel;
  }) => void;
  registerFileViewer: (v: {
    id: string;
    extensions: string[];
    mode?: "default" | "preview";
    component: typeof DiffView | typeof ConflictView;
  }) => void;
  registerCommand: (cmd: { id: string; label: string; defaultBinding?: string; run: () => void }) => void;
  app: {
    getActiveContext: () => ActiveContext;
    onDidChangeContext: (cb: (ctx: ActiveContext) => void) => () => void;
    openFileTab: (path: string) => void;
    openViewerTab: (viewerId: string, path: string, opts?: { title?: string }) => void;
    refreshFiles: () => void;
    setSidebarBadge: (panelId: string, badge: number | null) => void;
    getFileIcon: (fileName: string) => IconResult;
    getFolderIcon: (folderName: string, expanded: boolean) => IconResult;
    onDidChangeIconTheme: (cb: () => void) => () => void;
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
  getFileIcon = ctx.app.getFileIcon;
  getFolderIcon = ctx.app.getFolderIcon;
  onDidChangeIconTheme = ctx.app.onDidChangeIconTheme;
  extSettings = ctx.settings;

  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerSidebarPanel({
    id: "git",
    title: "Source Control",
    icon: "source-control",
    focusBinding: "ctrl+shift+KeyG",
    component: GitPanel,
  });
  // extensions: [] — never auto-matched to a file; reached only via
  // ctx.app.openViewerTab from GitPanel's row clicks (see openEntry above).
  ctx.registerFileViewer({ id: "diff", extensions: [], mode: "default", component: DiffView });
  ctx.registerFileViewer({ id: "conflict", extensions: [], mode: "default", component: ConflictView });

  // Start the badge poller immediately so it's correct on app startup,
  // rather than only after the user opens the Source Control tab.
  setPollCwd(ctx.app.getActiveContext().cwd);
  removeContextListener = ctx.app.onDidChangeContext((c) => setPollCwd(c.cwd));
  removeSettingsListener = ctx.settings.onDidChange(onSettingsChanged);

  // Palette commands that work whether or not the Source Control tab is the
  // active sidebar tab — resolve cwd from the active context and fetch a
  // fresh status rather than trusting the module-level poller's cache
  // (whose interval may not have ticked yet for a directory just switched
  // to). No bulk stage/unstage endpoint exists (server.js has only
  // per-path /stage and /unstage) — these compose the full path list
  // client-side, the same way the panel's own "Stage All"/"Unstage All"
  // header buttons do.
  ctx.registerCommand({
    id: "stageAll",
    label: "Git: Stage All Changes",
    run: async () => {
      const cwd = ctx.app.getActiveContext().cwd;
      if (!cwd) return;
      try {
        const data = await apiGetJson<StatusResponse>(`/status?cwd=${encodeURIComponent(cwd)}`);
        const paths = (data.unstaged ?? []).map((e) => e.path);
        if (paths.length === 0) return;
        await apiPost("/stage", { cwd, paths });
        refreshStatus();
        refreshFiles?.();
      } catch {
        // No error UI to report to when the panel isn't mounted — a
        // subsequent status poll (or the panel's own next refresh) surfaces
        // any real problem instead.
      }
    },
  });
  ctx.registerCommand({
    id: "unstageAll",
    label: "Git: Unstage All Changes",
    run: async () => {
      const cwd = ctx.app.getActiveContext().cwd;
      if (!cwd) return;
      try {
        const data = await apiGetJson<StatusResponse>(`/status?cwd=${encodeURIComponent(cwd)}`);
        const paths = (data.staged ?? []).map((e) => e.path);
        if (paths.length === 0) return;
        await apiPost("/unstage", { cwd, paths });
        refreshStatus();
        refreshFiles?.();
      } catch {
        // See stageAll's comment above.
      }
    },
  });
  ctx.registerCommand({
    id: "refresh",
    label: "Git: Refresh",
    run: () => {
      refreshStatus();
      refreshFiles?.();
    },
  });
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
  getFileIcon = null;
  getFolderIcon = null;
  onDidChangeIconTheme = null;
  removeStylesheet?.();
  removeStylesheet = null;
}

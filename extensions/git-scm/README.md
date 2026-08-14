# Git

A VS Code-style SOURCE CONTROL panel for the active directory's git repository: stage, commit, amend, push/pull/fetch, branch switching, stash, commit history, and diff.

## Contributes

- **Sidebar panel:** SOURCE CONTROL — staged/unstaged/conflicted file lists, stage/unstage/discard, commit message box (Ctrl/Cmd+Enter to commit, Amend toggle to rewrite HEAD instead of composing a new commit), a branch button (switch or create a local branch), a COMMITS section (recent history with unpushed markers, click a commit for its full diff, Load More), and a More Actions (`…`) menu for Pull/Push/Fetch/Stash/Pop Stash.
- **Diff viewer:** click a file to open its working-tree or staged diff, or a COMMITS row to open that commit's diff; Shift+click a file opens it in the editor instead.
- **Merge conflict resolver:** click a conflicted file to accept Current/Incoming/Both per block (or Accept All), then Save and Mark as Resolved — used for merge, rebase, cherry-pick/revert conflicts, and a stash pop that lands in conflict.
- **File tree git status:** modified/added/untracked/renamed/deleted badges in the FILES tree (see Settings → UI → "Git status in file tree" to toggle), plus a branch-name pill on the FILES tree root.

## Settings

- **Poll interval** (`gitScm.pollInterval`, default 3000ms) — how often the active directory's git status refreshes in the background; 0 disables polling.
- **Fetch interval** (`gitScm.fetchInterval`, default 0/off) — how often to run a non-interactive `git fetch` in the background so ahead/behind counts stay current; never prompts for credentials, so an auth-requiring remote just fails the fetch silently. Manual fetch is always available via More Actions (`…`).
- **File tree decorations** (`gitScm.fileTreeDecorations`, default on) — git status badges and row colors in the FILES tree; off skips the per-repo status scan.
- **Click action** (`gitScm.clickAction`, default "Open Diff") — what clicking a file in the panel opens; the other action is always available via Shift+click.

## Authentication

Push/pull/sync answer git and ssh prompts interactively: when the remote asks for anything — HTTPS username/password, an SSH key passphrase, or first-contact host-key confirmation (the fingerprint is shown verbatim) — a form appears in the panel. Under the hood every prompt is relayed from a `GIT_ASKPASS`/`SSH_ASKPASS` helper over a token-guarded unix socket; nothing is ever embedded in remote URLs.

- **In-memory cache:** answered HTTPS credentials are kept per host in the server process (never on disk), so repeated operations don't re-prompt until the server restarts. Rejected credentials are dropped automatically.
- **Remember credentials:** checking the box hands the pair to `git credential approve`, which stores it in whatever `credential.helper` you've configured (e.g. `git config --global credential.helper store`, or `cache`, `libsecret`, `gh`). With no helper configured it's a silent no-op — the extension itself never writes secrets to disk.
- **SSH:** agent keys (`SSH_AUTH_SOCK`) work as before with no prompting. Passphrase and host-key prompts rely on OpenSSH's `SSH_ASKPASS_REQUIRE=force` (OpenSSH ≥ 8.4). Unix sockets mean Linux/macOS only.

## Notes

Requires `git` on the server's PATH. Bundled with tmux-server.

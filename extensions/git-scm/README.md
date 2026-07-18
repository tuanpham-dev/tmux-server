# Git

A VS Code-style SOURCE CONTROL panel for the active directory's git repository: stage, commit, push/pull, and diff.

## Contributes

- **Sidebar panel:** SOURCE CONTROL — staged/unstaged file lists, stage/unstage/discard, commit message box, push/pull, and branch status.
- **Diff viewer:** click a file to open its working-tree or staged diff; Shift+click opens it in the editor instead.
- **File tree git status:** modified/added/untracked/renamed/deleted badges in the FILES tree (see Settings → UI → "Git status in file tree" to toggle).

## Settings

- **Poll interval** (`gitScm.pollInterval`, default 3000ms) — how often the active directory's git status refreshes in the background; 0 disables polling.
- **Click action** (`gitScm.clickAction`, default "Open Diff") — what clicking a file in the panel opens; the other action is always available via Shift+click.

## Authentication

Push/pull/sync answer git and ssh prompts interactively: when the remote asks for anything — HTTPS username/password, an SSH key passphrase, or first-contact host-key confirmation (the fingerprint is shown verbatim) — a form appears in the panel. Under the hood every prompt is relayed from a `GIT_ASKPASS`/`SSH_ASKPASS` helper over a token-guarded unix socket; nothing is ever embedded in remote URLs.

- **In-memory cache:** answered HTTPS credentials are kept per host in the server process (never on disk), so repeated operations don't re-prompt until the server restarts. Rejected credentials are dropped automatically.
- **Remember credentials:** checking the box hands the pair to `git credential approve`, which stores it in whatever `credential.helper` you've configured (e.g. `git config --global credential.helper store`, or `cache`, `libsecret`, `gh`). With no helper configured it's a silent no-op — the extension itself never writes secrets to disk.
- **SSH:** agent keys (`SSH_AUTH_SOCK`) work as before with no prompting. Passphrase and host-key prompts rely on OpenSSH's `SSH_ASKPASS_REQUIRE=force` (OpenSSH ≥ 8.4). Unix sockets mean Linux/macOS only.

## Notes

Requires `git` on the server's PATH. Bundled with tmux-server.

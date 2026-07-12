# Git

A VS Code-style SOURCE CONTROL panel for the active directory's git repository: stage, commit, push/pull, and diff.

## Contributes

- **Sidebar panel:** SOURCE CONTROL — staged/unstaged file lists, stage/unstage/discard, commit message box, push/pull, and branch status.
- **Diff viewer:** click a file to open its working-tree or staged diff; Shift+click opens it in the editor instead.
- **File tree git status:** modified/added/untracked/renamed/deleted badges in the FILES tree (see Settings → UI → "Git status in file tree" to toggle).

## Settings

- **Poll interval** (`gitScm.pollInterval`, default 3000ms) — how often the active directory's git status refreshes in the background; 0 disables polling.
- **Click action** (`gitScm.clickAction`, default "Open Diff") — what clicking a file in the panel opens; the other action is always available via Shift+click.

## Notes

Requires `git` on the server's PATH. Bundled with tmux-server.

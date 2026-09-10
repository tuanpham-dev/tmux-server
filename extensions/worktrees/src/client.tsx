// worktrees: two palette commands that open the PROJECTS tree's
// create-worktree form.
//
// This extension used to own a WORKTREES sidebar panel and a server hook of
// its own. Worktrees are now a level of the PROJECTS tree — project →
// worktree → terminal — with core owning the git calls, the listing, and the
// create/remove flows, because an extension can't contribute rows to a core
// tree. See plans/worktrees-into-projects.md.
//
// What's left is the part that is still extension-shaped: named entry points
// in the command palette. Both hand off to ctx.app.newWorktree.

interface ExtensionContext {
  registerCommand(command: { id: string; label: string; defaultBinding?: string; run: () => void }): void;
  app: {
    newWorktree(opts?: { runCommandIndex?: number }): void;
  };
}

export function activate(ctx: ExtensionContext): void {
  // Ships unbound (palette-only), like the built-in session commands.
  ctx.registerCommand({
    id: "newWorktreeSession",
    label: "Worktrees: New Worktree Session…",
    run: () => ctx.app.newWorktree(),
  });

  // Same form, but preselects the first configured run command — for when
  // starting an agent is the point, not an afterthought. The list itself is
  // the worktreeRunCommands app setting.
  ctx.registerCommand({
    id: "newAgentSession",
    label: "Worktrees: New Agent Session…",
    run: () => ctx.app.newWorktree({ runCommandIndex: 0 }),
  });
}

export function deactivate(): void {}

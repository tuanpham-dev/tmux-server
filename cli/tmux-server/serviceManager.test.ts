import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plist, LABEL } from './launchd.ts';
import { REPO_DIR } from './paths.ts';

test('the launchd agent runs the CLI, restarts on crash and leaves the daemon alone', () => {
  const text = plist('/Users/me/.local/share/tmux-server/bin/tmux-server', '/Users/me/Library/Logs/tmux-server.log', '/opt/homebrew/bin:/usr/bin');
  assert.match(text, new RegExp(`<key>Label</key>\\s*<string>${LABEL}</string>`));
  assert.match(text, /<string>\/Users\/me\/.local\/share\/tmux-server\/bin\/tmux-server<\/string>\s*<string>run<\/string>/);
  assert.match(text, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(text, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  assert.match(text, /<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
});

test('launchd values are escaped for XML', () => {
  const text = plist('/tmp/a&b<c>/tmux-server', '/tmp/log', '/bin');
  assert.match(text, /\/tmp\/a&amp;b&lt;c&gt;\/tmux-server/);
});

test('the systemd unit runs the CLI and only signals its main process', () => {
  const unit = readFileSync(join(REPO_DIR, 'systemd', 'tmux-server.service'), 'utf8');
  assert.match(unit, /^ExecStart=.*\/bin\/tmux-server run$/m);
  // The terminal daemon the server starts must survive a restart.
  assert.match(unit, /^KillMode=process$/m);
});

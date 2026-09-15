import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForMatch } from './wait.ts';

// The daemon answers capability queries from its own copy of the terminal.
//
// Nothing else can, reliably. A browser's answer crosses a socket twice and
// often arrives after the asking program has stopped reading, landing at the
// prompt as garbage — and with no browser attached at all there is nobody to
// answer, so a program that asks simply waits out its timeout.

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;
const DAEMON = new URL('../src/daemon/index.ts', import.meta.url).pathname;

function makeEnv(): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mux-q-'));
  return { dir, env: { ...process.env, TMUX_SERVER_STATE_DIR: join(dir, 's'), TMUX_SERVER_CONFIG_DIR: join(dir, 'c') } as Record<string, string> };
}
function sp(env: Record<string, string>, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { env }).toString();
}
function killDaemons(env: Record<string, string>): void {
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const argv = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      const e2 = readFileSync(`/proc/${d}/environ`, 'utf8');
      if (argv[1] === DAEMON && e2.includes(`TMUX_SERVER_STATE_DIR=${env.TMUX_SERVER_STATE_DIR}`)) process.kill(Number(d), 'SIGKILL');
    } catch { /* gone */ }
  }
}

test('a cursor-position query is answered with no viewer attached', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'q');
    await waitForMatch('the session to be listed', () => sp(env, 'ls'), /\bq\b/);

    // Ask, then read the reply with a timeout. Without an answer this prints
    // an empty CPR and the test fails on the missing row/column.
    sp(env, 'send', 'q:0',
      `bash -c 'printf "\\033[6n"; IFS= read -r -s -t 3 -d R p; printf "CPR<%s>\\n" "$(printf %s "$p" | tr -d "\\033[")"'`,
      '--enter');

    const out = await waitForMatch('the reply to reach the asking program',
      () => sp(env, 'capture', 'q:0', '-S', '20'), /CPR<\d+;\d+>/);
    assert.match(out, /CPR<\d+;\d+>/, 'the program received a row;column report');
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a replayed query is not answered into a shell that never asked', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'config', 'set', 'snapshotDebounceMs', '300');
    sp(env, 'new', 'r');
    await waitForMatch('the session to be listed', () => sp(env, 'ls'), /\br\b/);
    // Put a query into the scrollback, so restoring replays it.
    sp(env, 'send', 'r:0', `printf 'MARKER\\033[c'`, '--enter');
    await waitForMatch('the marker to land', () => sp(env, 'capture', 'r:0', '-S', '20'), /MARKER/);

    killDaemons(env);
    await waitForMatch('a respawned daemon', () => sp(env, 'ls'), /\br\b/);

    // The restored shell must be at a clean prompt. A replayed query answered
    // into it would appear as the response text typed at that prompt.
    const after = await waitForMatch('the restore banner',
      () => sp(env, 'capture', 'r:0', '-S', '30'), /\[restored/);
    const afterBanner = after.slice(after.indexOf('[restored'));
    assert.doesNotMatch(afterBanner, /\??1;2c/, `replayed query was answered into the shell:\n${afterBanner}`);
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

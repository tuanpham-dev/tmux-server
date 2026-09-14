// Two Claude windows in one directory must resolve to their own sessions -
// the bug this lookup replaced gave both the newest transcript in the cwd.
import assert from "node:assert/strict";
import { test } from "node:test";
import { paneIdFromTmuxField, sessionsByPane } from "./claudePanes.mjs";

const alive = new Set([100, 200, 300]);
const isAlive = (pid) => alive.has(pid);
const rec = (pid, sessionId, tmux, updatedAt = 1) => ({ pid, sessionId, tmux, cwd: "/repo", updatedAt });

test("reads the pane id from the tmux field", () => {
  assert.equal(paneIdFromTmuxField("tmuxserver-view-beb4b335:@0.%0"), "%0");
  assert.equal(paneIdFromTmuxField("work:@12.%25"), "%25");
  assert.equal(paneIdFromTmuxField(undefined), null);
  assert.equal(paneIdFromTmuxField("no pane here"), null);
});

test("two sessions in the same directory stay on their own panes", () => {
  const map = sessionsByPane([rec(100, "a", "s:@0.%0"), rec(200, "b", "s:@1.%25")], isAlive);
  assert.equal(map.get("%0").sessionId, "a");
  assert.equal(map.get("%25").sessionId, "b");
});

test("a record left behind by an exited CLI is ignored", () => {
  const map = sessionsByPane([rec(999, "dead", "s:@0.%0"), rec(100, "live", "s:@0.%0")], isAlive);
  assert.equal(map.get("%0").sessionId, "live");
});

test("the most recently updated live record wins for a pane", () => {
  const map = sessionsByPane([rec(100, "old", "s:@0.%3", 5), rec(300, "new", "s:@0.%3", 9)], isAlive);
  assert.equal(map.get("%3").sessionId, "new");
});

test("records without a pane or session id are skipped", () => {
  const map = sessionsByPane([rec(100, "x", undefined), { pid: 200, tmux: "s:@0.%1" }, null], isAlive);
  assert.equal(map.size, 0);
});

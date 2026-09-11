// One poll of /api/system-stats, however many things are watching it, at
// whichever depth the deepest watcher needs.
//
// The status bar's own memory reading and the popover that reading opens are
// two separate subscribers, and the popover's content is a node the bar
// captured at click time — a component that fetched for itself would both
// double the request rate and, when the bar's captured node went stale, be
// the only one still moving. Subscribing to a module singleton solves both.
//
// It also decides how much the server does per poll. The bar needs memory;
// everything else in the reading exists only for the popover, and asking for
// it includes a statfs per filesystem, which can block for as long as a
// stalled mount takes to answer. So the detailed reading is requested only
// while something is actually rendering it — see useDetailedSystemStats.
//
// Same "module singleton, not prop-threaded" shape as lib/pollTick.ts, whose
// 3s sessions tick is also what drives this.

import { useSyncExternalStore } from "react";
import * as api from "../api";
import { subscribePollTick } from "./pollTick";
import type { SystemStats } from "./systemStats";

let current: SystemStats | null = null;
const listeners = new Set<() => void>();
let detailWatchers = 0;
let unsubscribeTick: (() => void) | null = null;

function load(): void {
  if (document.hidden) return;
  api
    .fetchSystemStats(detailWatchers > 0)
    .then((next) => {
      // A light reading has no detail block, but keeping the last one means
      // reopening the popover paints the previous numbers immediately rather
      // than flashing a loading line — the detailed poll that the reopening
      // itself fires replaces them a moment later.
      current = next.detail ? next : { ...next, detail: current?.detail };
      for (const listener of listeners) listener();
    })
    // A failed poll leaves the last reading on screen rather than blanking
    // the bar or raising a banner — this is ambient information, not
    // something worth interrupting anyone over.
    .catch(() => {});
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // First watcher starts the feed; the rest ride it. A late subscriber (the
  // popover opening) paints immediately from `current` and then follows the
  // same tick, so opening it costs no extra request.
  if (listeners.size === 1) {
    load();
    unsubscribeTick = subscribePollTick(load);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      unsubscribeTick?.();
      unsubscribeTick = null;
    }
  };
}

// null until the first poll answers. The reference only changes when a poll
// succeeds, which is what useSyncExternalStore needs of a snapshot.
export function useSystemStats(): SystemStats | null {
  return useSyncExternalStore(subscribe, () => current);
}

function subscribeDetailed(onChange: () => void): () => void {
  detailWatchers++;
  const unsubscribe = subscribe(onChange);
  // Don't make the panel wait up to a full tick for the block it exists to
  // render: ask for a detailed reading the moment one is wanted. (Skipped
  // when subscribe() has just fired that same request for the first
  // watcher.)
  if (listeners.size > 1) load();
  return () => {
    detailWatchers--;
    unsubscribe();
  };
}

// Same snapshot as useSystemStats, but the detailed one: while a component
// using this is mounted, every poll asks the server for the full reading.
export function useDetailedSystemStats(): SystemStats | null {
  return useSyncExternalStore(subscribeDetailed, () => current);
}

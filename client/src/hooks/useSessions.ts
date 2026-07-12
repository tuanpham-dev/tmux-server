import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { TmuxSession } from "../types";

// Sessions state + the 3s poll. `onAfterRefresh` is called at the end of
// every refresh (success or failure) — App wires it to bump filesRefreshKey
// so FILES-panel git badges piggyback on this same poll instead of a second
// timer (see useFileActions).
export function useSessions(showError: (err: unknown) => void, onAfterRefresh: () => void) {
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  // Guards the window-tab cleanup effect (useTabs) against the very first
  // render, where `sessions` is still its initial [] — without this, every
  // restored window-tab would look "gone" and get closed before the first
  // fetch even completes.
  const sessionsLoadedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setSessions(await api.fetchSessions());
      sessionsLoadedRef.current = true;
    } catch (err) {
      showError(err);
    }
    onAfterRefresh();
  }, [showError, onAfterRefresh]);

  useEffect(() => {
    refresh();
    // Skip ticks while the tab is hidden (background tab, minimized window)
    // — no point spawning tmux twice a second for nothing on screen; an
    // immediate refresh on regaining visibility keeps state from going stale
    // for the 3s until the next tick would've fired anyway.
    const t = setInterval(() => {
      if (!document.hidden) refresh();
    }, 3000);
    const onVisibility = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  return { sessions, refresh, sessionsLoadedRef };
}

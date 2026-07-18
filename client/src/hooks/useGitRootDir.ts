import { useEffect, useState } from "react";
import * as api from "../api";

// cwd → resolved root, shared across every hook instance and persisted for the
// page's lifetime. A given directory's git root never changes under us, so a
// tab switch back to an already-seen cwd resolves synchronously with no
// refetch and no flicker. Failed lookups aren't cached (transient errors
// shouldn't stick a directory on its cwd fallback forever).
const rootCache = new Map<string, string>();

// Resolves the FILES panel / quick-switcher root: the git repo containing the
// active window's `cwd`, or `cwd` itself when it isn't inside a repo.
//
// Returns null while a first-time lookup is in flight (FileTree renders its
// empty state for a null root, so the tree doesn't briefly show the cwd and
// then re-root at the repo). Falls back to `cwd` if the lookup errors.
export function useGitRootDir(cwd: string | null): string | null {
  const [root, setRoot] = useState<string | null>(() => (cwd ? (rootCache.get(cwd) ?? null) : null));

  useEffect(() => {
    if (!cwd) {
      setRoot(null);
      return;
    }
    const cached = rootCache.get(cwd);
    if (cached !== undefined) {
      setRoot(cached);
      return;
    }
    // Not yet known: clear to null (empty state) while we resolve, and ignore
    // the response if `cwd` changed out from under this effect meanwhile.
    setRoot(null);
    let stale = false;
    api
      .getGitRoot(cwd)
      .then(({ root: resolved }) => {
        rootCache.set(cwd, resolved);
        if (!stale) setRoot(resolved);
      })
      .catch(() => {
        if (!stale) setRoot(cwd);
      });
    return () => {
      stale = true;
    };
  }, [cwd]);

  return root;
}

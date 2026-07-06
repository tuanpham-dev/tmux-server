import { useEffect, useRef, useState } from "react";
import type { MenuItem, Tab, TabGroupState } from "../types";
import { adjustForContrast, GROUP_COLORS, groupColorHex } from "../utils/groupColor";
import { getFileIconResult, useIconThemeVersion } from "../utils/iconThemes";
import FileIcon from "./FileIcon";
import Icon from "./Icon";

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  label: (tab: Tab) => string;
  activity: (tab: Tab) => boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onShowMenu: (x: number, y: number, items: MenuItem[]) => void;
  tabMenuItems: (tab: Tab) => MenuItem[];
  onReorder: (draggedId: string, toIndex: number) => void;
  // Reports the actions container's DOM element as it mounts/unmounts, so a
  // tab (e.g. an image viewer) can portal per-tab controls into it — VS
  // Code/code-server style editor-actions on the right of the tab strip.
  actionsRef: (el: HTMLDivElement | null) => void;
  onToggleSidebar: () => void;
  // Chrome-style tab groups (settings.tabGroupsBySession) — see
  // plans/tab-groups-by-session.md. groupKey returns null for a tab that
  // isn't grouped (settings/extension-viewer tabs).
  groupingEnabled: boolean;
  groupKey: (tab: Tab) => string | null;
  groupState: Record<string, TabGroupState>;
  onToggleGroupCollapsed: (sessionName: string) => void;
  groupMenuItems: (sessionName: string) => MenuItem[];
}

// Long-press delay (touch/pen) before a hold starts a drag instead of letting
// the gesture fall through to the tab bar's native horizontal scroll.
const LONG_PRESS_MS = 300;
// Movement past this cancels a pending touch long-press (treated as a scroll)
// or, on mouse, arms a drag once exceeded.
const MOVE_SLOP_PX = 8;
const MOUSE_DRAG_THRESHOLD_PX = 5;

type DropIndicator = { id: string; edge: "left" | "right" };

// Restricts drag-drop candidates when tab groups are enabled: a grouped tab
// may only reorder within its own group (members are always kept contiguous
// by lib/tabs.ts's normalizeTabGroups), and an ungrouped tab may only drop at a
// group's edge, never wedged between its members.
function computeGroupConstrainedOrder(
  order: Tab[],
  draggedTab: Tab,
  groupingEnabled: boolean,
  groupKey: (tab: Tab) => string | null,
): Tab[] {
  if (!groupingEnabled) return order;
  const draggedKey = groupKey(draggedTab);
  if (draggedKey !== null) {
    return order.filter((t) => groupKey(t) === draggedKey);
  }
  return order.filter((t, i) => {
    const key = groupKey(t);
    if (key === null) return true;
    const prevKey = i > 0 ? groupKey(order[i - 1]) : undefined;
    const nextKey = i < order.length - 1 ? groupKey(order[i + 1]) : undefined;
    return prevKey !== key || nextKey !== key;
  });
}

export default function TabBar({
  tabs,
  activeTabId,
  label,
  activity,
  onActivate,
  onClose,
  onShowMenu,
  tabMenuItems,
  onReorder,
  actionsRef,
  onToggleSidebar,
  groupingEnabled,
  groupKey,
  groupState,
  onToggleGroupCollapsed,
  groupMenuItems,
}: Props) {
  // Re-renders the strip when the active icon theme changes — getFileIconResult
  // reads module-level state directly, same subscribe-to-force-render shape
  // FileTree uses (see utils/iconThemes.ts's useIconThemeVersion).
  useIconThemeVersion();

  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const tabBarRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const justDraggedRef = useRef(false);

  // Resolved tab-bar background, used to contrast-adjust group colors
  // against whatever the active color theme actually renders (a fixed
  // palette tuned for the bundled dark theme could otherwise wash out
  // against a light one) — see utils/groupColor's adjustForContrast.
  // Recomputed on mount and whenever a color theme applies its CSS vars
  // (theme.ts's applyColorThemeCssVars sets them directly on
  // document.documentElement.style, so observing that attribute catches
  // every theme swap without new props threaded down from App).
  const [barBg, setBarBg] = useState("#21252b");
  useEffect(() => {
    const recompute = () => {
      const el = tabBarRef.current;
      if (el) setBarBg(getComputedStyle(el).backgroundColor);
    };
    recompute();
    const observer = new MutationObserver(recompute);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  }, []);

  // Mutable drag session state — kept out of React state since it updates on
  // every pointermove and must be readable synchronously from window
  // listeners registered outside React's event system.
  const sessionRef = useRef<{
    pointerId: number;
    tabId: string;
    pointerType: string;
    startX: number;
    startY: number;
    dragging: boolean;
    longPressTimer: ReturnType<typeof setTimeout> | null;
    insertIndex: number;
  } | null>(null);

  const computeInsertion = (clientX: number, draggedId: string): DropIndicator | null => {
    const fullOrder = tabs.filter((t) => t.id !== draggedId);
    const draggedTab = tabs.find((t) => t.id === draggedId);
    const order = draggedTab
      ? computeGroupConstrainedOrder(fullOrder, draggedTab, groupingEnabled, groupKey)
      : fullOrder;
    if (order.length === 0) return null;
    for (const t of order) {
      const el = tabRefs.current.get(t.id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return { id: t.id, edge: "left" };
      if (clientX < rect.right) return { id: t.id, edge: "right" };
    }
    return { id: order[order.length - 1].id, edge: "right" };
  };

  const indicatorToIndex = (indicator: DropIndicator, draggedId: string): number => {
    const order = tabs.filter((t) => t.id !== draggedId);
    const idx = order.findIndex((t) => t.id === indicator.id);
    return indicator.edge === "left" ? idx : idx + 1;
  };

  const removeWindowListeners = () => {
    window.removeEventListener("pointermove", onPointerMoveWindow);
    window.removeEventListener("pointerup", onPointerUpWindow);
    window.removeEventListener("pointercancel", onPointerCancelWindow);
  };

  const endSession = () => {
    const session = sessionRef.current;
    if (session?.longPressTimer) clearTimeout(session.longPressTimer);
    sessionRef.current = null;
    setDragTabId(null);
    setDropIndicator(null);
  };

  // Safety net: if TabBar unmounts mid-drag (session still active), the
  // gesture's own pointerup/pointercancel will never fire to remove these —
  // tear them down here directly (no setState — the component is gone).
  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      if (!session) return;
      if (session.longPressTimer) clearTimeout(session.longPressTimer);
      removeWindowListeners();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startDragging = () => {
    const session = sessionRef.current;
    if (!session || session.dragging) return;
    session.dragging = true;
    setDragTabId(session.tabId);
  };

  const onPointerMoveWindow = (e: PointerEvent) => {
    const session = sessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    const dx = e.clientX - session.startX;
    const dy = e.clientY - session.startY;

    if (!session.dragging) {
      if (session.pointerType === "mouse") {
        if (Math.hypot(dx, dy) >= MOUSE_DRAG_THRESHOLD_PX) startDragging();
        else return;
      } else {
        // Touch/pen: movement before the long-press timer fires cancels the
        // pending drag so a horizontal swipe keeps scrolling the bar.
        if (Math.hypot(dx, dy) >= MOVE_SLOP_PX) {
          endSession();
          return;
        }
        return;
      }
    }

    const indicator = computeInsertion(e.clientX, session.tabId);
    setDropIndicator(indicator);
    if (indicator) session.insertIndex = indicatorToIndex(indicator, session.tabId);
  };

  const onPointerUpWindow = (e: PointerEvent) => {
    const session = sessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    window.removeEventListener("pointermove", onPointerMoveWindow);
    window.removeEventListener("pointerup", onPointerUpWindow);
    window.removeEventListener("pointercancel", onPointerCancelWindow);
    if (session.dragging) {
      justDraggedRef.current = true;
      onReorder(session.tabId, session.insertIndex);
    }
    endSession();
  };

  const onPointerCancelWindow = (e: PointerEvent) => {
    const session = sessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    window.removeEventListener("pointermove", onPointerMoveWindow);
    window.removeEventListener("pointerup", onPointerUpWindow);
    window.removeEventListener("pointercancel", onPointerCancelWindow);
    endSession();
  };

  const handleTabPointerDown = (e: React.PointerEvent, tabId: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".tab-close")) return;

    sessionRef.current = {
      pointerId: e.pointerId,
      tabId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      longPressTimer: null,
      insertIndex: tabs.findIndex((t) => t.id === tabId),
    };

    if (e.pointerType !== "mouse") {
      sessionRef.current.longPressTimer = setTimeout(() => {
        if (sessionRef.current?.tabId === tabId) startDragging();
      }, LONG_PRESS_MS);
    }

    window.addEventListener("pointermove", onPointerMoveWindow);
    window.addEventListener("pointerup", onPointerUpWindow);
    window.addEventListener("pointercancel", onPointerCancelWindow);
  };

  // Suppresses native touch scrolling only while a drag is actually in
  // progress — must be a non-passive listener since React's onTouchMove
  // can't preventDefault a scroll that's already begun.
  const handleBarTouchMove = (e: React.TouchEvent) => {
    if (sessionRef.current?.dragging) e.preventDefault();
  };

  // Plain (unshifted) mouse wheel scrolls the strip horizontally too, not
  // just Shift+wheel (the browser's native horizontal-scroll gesture).
  // Native (non-passive) listener: React's onWheel can't preventDefault a
  // scroll that's already begun.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey || e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const handleTabClick = (id: string) => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    onActivate(id);
  };

  useEffect(() => {
    if (!activeTabId) return;
    tabRefs.current.get(activeTabId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs]);

  // Per-group contrast-adjusted line color and aggregated activity — one
  // pass over `tabs`, computed only while grouping is on.
  const groupColorFor: Record<string, string> = {};
  const groupHasActivity: Record<string, boolean> = {};
  if (groupingEnabled) {
    for (const tab of tabs) {
      const key = groupKey(tab);
      if (key === null) continue;
      if (!(key in groupColorFor)) {
        groupColorFor[key] = adjustForContrast(groupColorHex(groupState[key]?.color ?? GROUP_COLORS[0].key), barBg);
      }
      if (activity(tab)) groupHasActivity[key] = true;
    }
  }

  const renderTab = (tab: Tab, groupLineColor?: string) => {
    const indicatorClass =
      dropIndicator?.id === tab.id ? ` drop-indicator-${dropIndicator.edge}` : "";
    const draggingClass = dragTabId === tab.id ? " dragging" : "";
    const groupedClass = groupLineColor ? " grouped" : "";
    return (
      <div
        key={tab.id}
        ref={(el) => {
          if (el) tabRefs.current.set(tab.id, el);
          else tabRefs.current.delete(tab.id);
        }}
        className={`tab${tab.id === activeTabId ? " active" : ""}${indicatorClass}${draggingClass}${groupedClass}`}
        style={groupLineColor ? ({ "--group-color": groupLineColor } as React.CSSProperties) : undefined}
        onPointerDown={(e) => handleTabPointerDown(e, tab.id)}
        onClick={() => handleTabClick(tab.id)}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest(".tab-close")) return;
          onToggleSidebar();
        }}
        onAuxClick={(e) => {
          if (e.button === 1) onClose(tab.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onShowMenu(e.clientX, e.clientY, tabMenuItems(tab));
        }}
      >
        {activity(tab) && <span className="activity-dot" />}
        {tab.settingsView && <Icon name="settings-gear" className="tab-type-icon" />}
        {tab.extViewerPath && (
          <FileIcon
            className="tab-file-icon"
            result={getFileIconResult(tab.extViewerPath.split("/").pop() ?? tab.extViewerPath)}
          />
        )}
        <span className="tab-title">{label(tab)}</span>
        <button
          className="tab-close"
          title="Close tab"
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
        >
          <Icon name="close" />
        </button>
      </div>
    );
  };

  const renderChip = (sessionName: string) => {
    const state = groupState[sessionName];
    const collapsed = state?.collapsed ?? false;
    const rawColor = groupColorHex(state?.color ?? GROUP_COLORS[0].key);
    return (
      <div
        key={`group:${sessionName}`}
        className="tab-group-chip"
        style={{ background: rawColor }}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={`${sessionName} tab group, ${collapsed ? "collapsed" : "expanded"}`}
        onClick={() => onToggleGroupCollapsed(sessionName)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          onToggleGroupCollapsed(sessionName);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onShowMenu(e.clientX, e.clientY, groupMenuItems(sessionName));
        }}
      >
        <Icon name={collapsed ? "chevron-right" : "chevron-down"} className="tab-group-chip-arrow" />
        <span className="tab-group-chip-label">{sessionName}</span>
        {groupHasActivity[sessionName] && <span className="activity-dot" />}
      </div>
    );
  };

  const nodes: React.ReactNode[] = [];
  const chippedGroups = new Set<string>();
  for (const tab of tabs) {
    const key = groupingEnabled ? groupKey(tab) : null;
    if (key === null) {
      nodes.push(renderTab(tab));
      continue;
    }
    if (!chippedGroups.has(key)) {
      chippedGroups.add(key);
      nodes.push(renderChip(key));
    }
    if (!(groupState[key]?.collapsed ?? false)) {
      nodes.push(renderTab(tab, groupColorFor[key]));
    }
  }

  return (
    <div className="tab-bar" ref={tabBarRef}>
      <div
        className="tab-strip"
        ref={barRef}
        onTouchMove={handleBarTouchMove}
      >
        {nodes}
      </div>
      <div className="tab-bar-actions" ref={actionsRef} />
    </div>
  );
}

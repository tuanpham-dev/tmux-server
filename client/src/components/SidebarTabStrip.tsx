import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";

export interface SidebarTabInfo {
  id: string;
  title: string;
  icon: string;
  badge?: number | null;
}

interface Props {
  tabs: SidebarTabInfo[];
  activeId: string;
  onSelect: (id: string) => void;
  onReorder: (id: string, toIndex: number) => void;
}

// Long-press delay (touch/pen) before a hold starts a drag instead of letting
// the gesture fall through to the strip's native horizontal scroll — mirrors
// TabBar's chip-drag thresholds (see plans/reorder-tab-groups.md).
const LONG_PRESS_MS = 300;
const MOVE_SLOP_PX = 8;
const MOUSE_DRAG_THRESHOLD_PX = 5;

type DropIndicator = { id: string; edge: "left" | "right" };

export default function SidebarTabStrip({ tabs, activeId, onSelect, onReorder }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const justDraggedRef = useRef(false);

  // Mutable drag session state — kept out of React state since it updates on
  // every pointermove and must be readable synchronously from window
  // listeners registered outside React's event system (same shape as
  // TabBar's sessionRef).
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
    const order = tabs.filter((t) => t.id !== draggedId);
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
    setDragId(null);
    setDropIndicator(null);
  };

  // Safety net: if the strip unmounts mid-drag, the gesture's own
  // pointerup/pointercancel will never fire to remove these — tear them
  // down here directly (no setState — the component is gone).
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
    setDragId(session.tabId);
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
        // pending drag so a horizontal swipe keeps scrolling the strip.
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
    removeWindowListeners();
    if (session.dragging) {
      justDraggedRef.current = true;
      onReorder(session.tabId, session.insertIndex);
    }
    endSession();
  };

  const onPointerCancelWindow = (e: PointerEvent) => {
    const session = sessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    removeWindowListeners();
    endSession();
  };

  const handlePointerDown = (e: React.PointerEvent, tabId: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;

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

  const handleClick = (tabId: string) => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    onSelect(tabId);
  };

  useEffect(() => {
    tabRefs.current.get(activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  return (
    <div className="sidebar-tabs" role="tablist" aria-label="Sidebar views">
      {tabs.map((tab) => {
        const indicatorClass =
          dropIndicator?.id === tab.id ? ` drop-indicator-${dropIndicator.edge}` : "";
        const draggingClass = dragId === tab.id ? " dragging" : "";
        return (
          <button
            key={tab.id}
            ref={(el) => {
              if (el) tabRefs.current.set(tab.id, el);
              else tabRefs.current.delete(tab.id);
            }}
            role="tab"
            type="button"
            aria-selected={tab.id === activeId}
            title={tab.title}
            className={`sidebar-tab${tab.id === activeId ? " active" : ""}${indicatorClass}${draggingClass}`}
            onPointerDown={(e) => handlePointerDown(e, tab.id)}
            onClick={() => handleClick(tab.id)}
          >
            <Icon name={tab.icon} />
            {!!tab.badge && <span className="sidebar-tab-badge">{tab.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

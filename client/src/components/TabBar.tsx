import { useRef, useState } from "react";
import type { MenuItem, Tab } from "../types";
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
}

// Long-press delay (touch/pen) before a hold starts a drag instead of letting
// the gesture fall through to the tab bar's native horizontal scroll.
const LONG_PRESS_MS = 300;
// Movement past this cancels a pending touch long-press (treated as a scroll)
// or, on mouse, arms a drag once exceeded.
const MOVE_SLOP_PX = 8;
const MOUSE_DRAG_THRESHOLD_PX = 5;

type DropIndicator = { id: string; edge: "left" | "right" };

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
}: Props) {
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const justDraggedRef = useRef(false);

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

  const endSession = () => {
    const session = sessionRef.current;
    if (session?.longPressTimer) clearTimeout(session.longPressTimer);
    sessionRef.current = null;
    setDragTabId(null);
    setDropIndicator(null);
  };

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

  const handleTabClick = (id: string) => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    onActivate(id);
  };

  return (
    <div className="tab-bar">
      <div
        className="tab-strip"
        ref={barRef}
        onTouchMove={handleBarTouchMove}
      >
        {tabs.map((tab) => {
          const indicatorClass =
            dropIndicator?.id === tab.id ? ` drop-indicator-${dropIndicator.edge}` : "";
          const draggingClass = dragTabId === tab.id ? " dragging" : "";
          return (
            <div
              key={tab.id}
              ref={(el) => {
                if (el) tabRefs.current.set(tab.id, el);
                else tabRefs.current.delete(tab.id);
              }}
              className={`tab${tab.id === activeTabId ? " active" : ""}${indicatorClass}${draggingClass}`}
              onPointerDown={(e) => handleTabPointerDown(e, tab.id)}
              onClick={() => handleTabClick(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) onClose(tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                onShowMenu(e.clientX, e.clientY, tabMenuItems(tab));
              }}
            >
              {activity(tab) && <span className="activity-dot" />}
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
        })}
      </div>
      <div className="tab-bar-actions" ref={actionsRef} />
    </div>
  );
}

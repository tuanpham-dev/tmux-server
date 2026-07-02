import type { MenuItem, Tab } from "../types";
import Icon from "./Icon";

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  label: (tab: Tab) => string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onShowMenu: (x: number, y: number, items: MenuItem[]) => void;
  tabMenuItems: (tab: Tab) => MenuItem[];
}

export default function TabBar({
  tabs,
  activeTabId,
  label,
  onActivate,
  onClose,
  onShowMenu,
  tabMenuItems,
}: Props) {
  return (
    <div className="tab-bar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab${tab.id === activeTabId ? " active" : ""}`}
          onClick={() => onActivate(tab.id)}
          onAuxClick={(e) => {
            if (e.button === 1) onClose(tab.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            onShowMenu(e.clientX, e.clientY, tabMenuItems(tab));
          }}
        >
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
      ))}
    </div>
  );
}

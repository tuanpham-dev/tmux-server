interface Props {
  visible: boolean;
  stickyCtrl: boolean;
  onToggleStickyCtrl: () => void;
  onSendInput: (data: string) => void;
}

// Minimal first cut for touch devices: keys a mobile keyboard can't send
// itself (Esc, Tab, arrows, Ctrl+C) plus a sticky Ctrl that applies to the
// next character typed, since holding Ctrl isn't possible with an on-screen
// keyboard. onPointerDown (not onClick) + preventDefault so tapping a button
// never steals focus from xterm's hidden textarea — losing it would dismiss
// the on-screen keyboard.
export default function TouchKeyBar({ visible, stickyCtrl, onToggleStickyCtrl, onSendInput }: Props) {
  if (!visible) return null;

  const key = (label: string, data: string) => (
    <button
      key={label}
      className="touch-key"
      onPointerDown={(e) => {
        e.preventDefault();
        onSendInput(data);
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="touch-key-bar">
      {key("Esc", "\x1b")}
      {key("Tab", "\t")}
      <button
        className={`touch-key touch-key-ctrl${stickyCtrl ? " active" : ""}`}
        onPointerDown={(e) => {
          e.preventDefault();
          onToggleStickyCtrl();
        }}
      >
        Ctrl
      </button>
      {key("←", "\x1b[D")}
      {key("↑", "\x1b[A")}
      {key("↓", "\x1b[B")}
      {key("→", "\x1b[C")}
      {key("^C", "\x03")}
    </div>
  );
}

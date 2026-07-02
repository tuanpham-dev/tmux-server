import { useEffect, useRef } from "react";

export interface DialogRequest {
  type: "confirm" | "prompt";
  message: string;
  defaultValue?: string;
  danger?: boolean;
  confirmLabel?: string;
  resolve: (result: string | boolean | null) => void;
}

interface Props {
  dialog: DialogRequest;
}

export default function Dialog({ dialog }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (dialog.type === "prompt") {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      confirmRef.current?.focus();
    }
  }, [dialog]);

  const cancel = () => dialog.resolve(dialog.type === "prompt" ? null : false);
  const confirm = () =>
    dialog.resolve(dialog.type === "prompt" ? (inputRef.current?.value ?? "") : true);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    }
  };

  return (
    <div className="dialog-overlay" onMouseDown={cancel}>
      <div
        className="dialog"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="dialog-message">{dialog.message}</div>
        {dialog.type === "prompt" && (
          <input
            ref={inputRef}
            className="dialog-input"
            defaultValue={dialog.defaultValue ?? ""}
          />
        )}
        <div className="dialog-buttons">
          <button className="dialog-button secondary" onClick={cancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            className={`dialog-button primary${dialog.danger ? " danger" : ""}`}
            onClick={confirm}
          >
            {dialog.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

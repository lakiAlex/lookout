import { useState, type ReactNode } from "react";
import { Dialog } from "./Dialog";

export function ChoiceDialog(props: {
  title: string;
  message: ReactNode;
  onCancel: () => void;
  actions: { label: string; kind?: "primary" | "danger-ghost"; onClick: () => void }[];
}) {
  // With several actions the first one sits on the left, away from the others.
  const secondary = props.actions.length > 1 ? props.actions[0] : undefined;
  const rest = secondary ? props.actions.slice(1) : props.actions;
  return (
    <Dialog
      title={props.title}
      onClose={props.onCancel}
      onSubmit={() => rest[rest.length - 1]?.onClick()}
      footer={
        <>
          {secondary && (
            <button type="button" className={`button ${secondary.kind ?? ""}`} onClick={secondary.onClick}>
              {secondary.label}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="button" onClick={props.onCancel}>
            Cancel
          </button>
          {rest.map((action, i) => (
            <button
              key={action.label}
              type={i === rest.length - 1 ? "submit" : "button"}
              className={`button ${action.kind ?? ""}`}
              onClick={i === rest.length - 1 ? undefined : action.onClick}
              data-autofocus={i === rest.length - 1 ? true : undefined}
            >
              {action.label}
            </button>
          ))}
        </>
      }
    >
      <div className="dialog-message">{props.message}</div>
    </Dialog>
  );
}

export function InputDialog(props: {
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState(props.initial);
  return (
    <Dialog
      title={props.title}
      onClose={props.onCancel}
      onSubmit={() => props.onConfirm(value)}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{props.label}</span>
        <input value={value} spellCheck={false} onChange={(e) => setValue(e.target.value)} />
      </label>
    </Dialog>
  );
}

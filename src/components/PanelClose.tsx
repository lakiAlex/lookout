import { X } from "./icons";

/** The close button at the right end of a side panel's header. */
export function PanelClose(props: { onClose: () => void }) {
  return (
    <button type="button" className="icon-button" title="Close" aria-label="Close" onClick={props.onClose}>
      <X size={14} />
    </button>
  );
}

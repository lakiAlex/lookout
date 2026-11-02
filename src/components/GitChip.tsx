import type { GitStatus } from "../api";
import { Check, GitCommit } from "./icons";

/** The changes in the folder's repository, in the title bar: changed files
 * and lines added and removed. A click opens Source Control. */
export function GitChip(props: { status: GitStatus; open: boolean; onClick: () => void }) {
  const { files, added, removed } = props.status;
  const count = files.length;
  const tip = count
    ? `${count} changed ${count === 1 ? "file" : "files"}, ${added} ${added === 1 ? "line" : "lines"} added, ${removed} removed. Source Control (⌃⇧G)`
    : "No changes. Source Control (⌃⇧G)";
  return (
    <button type="button" className={`git-chip${props.open ? " open" : ""}${count ? "" : " clean"}`} title={tip} aria-label={tip} onClick={props.onClick}>
      {count ? <GitCommit size={14} /> : <Check size={13} />}
      {count > 0 && (
        <>
          {/* Keyed on the value, so a changed number plays its tick animation. */}
          <span key={`f${count}`} className="git-chip-count">
            {count}
          </span>
          <span key={`a${added}`} className="git-chip-added">
            +{added.toLocaleString("en-US")}
          </span>
          <span key={`r${removed}`} className="git-chip-removed">
            −{removed.toLocaleString("en-US")}
          </span>
        </>
      )}
    </button>
  );
}

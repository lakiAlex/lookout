import { ArrowDown, ArrowUp, Check, ChevronRight, FileText, GitBranch, LoaderCircle, Minus, Plus, RefreshCw, Undo2 } from "./icons";
import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { basename, dirname, type GitFile, type GitStatus } from "../api";
import { iconUrl } from "../icons";

interface GitPanelProps {
  status: GitStatus | null | undefined;
  busy: string | null;
  onRefresh: () => void;
  onCommit: (message: string, amend: boolean) => Promise<boolean>;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (files: GitFile[]) => void;
  onDiff: (file: GitFile, staged: boolean) => void;
  onOpen: (file: GitFile) => void;
  onSync: () => void;
  onBranchMenu: (e: ReactMouseEvent) => void;
}

const LABELS: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", "?": "Untracked", U: "Conflict", T: "Type changed" };

function kind(letter: string): string {
  if (letter === "?" || letter === "A") return "added";
  if (letter === "D") return "deleted";
  if (letter === "U") return "conflict";
  if (letter === "R" || letter === "C") return "renamed";
  return "modified";
}

export function GitPanel(props: GitPanelProps) {
  const [message, setMessage] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const status = props.status;

  if (status === undefined) {
    return (
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">Source Control</span>
        </div>
        <div className="panel-empty">
          <LoaderCircle size={14} className="spin" />
        </div>
      </div>
    );
  }
  if (status === null) {
    return (
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">Source Control</span>
        </div>
        <div className="panel-empty">This folder is not in a git repository.</div>
      </div>
    );
  }

  const staged = status.files.filter((f) => f.index !== "." && f.index !== "?");
  const changes = status.files.filter((f) => f.work !== ".");
  const conflicts = status.files.filter((f) => f.index === "U");

  const commit = async () => {
    if (!message.trim()) return;
    if (await props.onCommit(message, false)) setMessage("");
  };

  const section = (id: string, title: string, files: GitFile[], isStaged: boolean) => {
    if (files.length === 0) return null;
    const open = !closed.has(id);
    return (
      <div className="git-section">
        <div
          className="git-section-title"
          onClick={() =>
            setClosed((s) => {
              const next = new Set(s);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
        >
          <span className={`tree-chevron${open ? " open" : ""}`}>
            <ChevronRight size={13} />
          </span>
          <span className="git-section-name">{title}</span>
          <span className="git-section-actions" onClick={(e) => e.stopPropagation()}>
            {isStaged ? (
              <button type="button" className="icon-button" title="Unstage All" onClick={() => props.onUnstage(files.map((f) => f.path))}>
                <Minus size={14} />
              </button>
            ) : (
              <>
                <button type="button" className="icon-button" title="Discard All Changes" onClick={() => props.onDiscard(files)}>
                  <Undo2 size={14} />
                </button>
                <button type="button" className="icon-button" title="Stage All" onClick={() => props.onStage(files.map((f) => f.path))}>
                  <Plus size={14} />
                </button>
              </>
            )}
          </span>
          <span className="git-count">{files.length}</span>
        </div>
        {open &&
          files.map((file) => {
            const letter = isStaged ? file.index : file.work === "?" ? "U" : file.work;
            const shown = isStaged ? file.index : file.work;
            return (
              <div
                key={file.path}
                className={`git-row git-${kind(shown)}`}
                title={`${file.path}${file.from ? ` (from ${file.from})` : ""}: ${LABELS[shown] ?? shown}`}
                onClick={() => props.onDiff(file, isStaged)}
              >
                <img className="tree-icon" src={iconUrl(basename(file.path), false)} alt="" />
                <span className={`tree-name${shown === "D" ? " deleted" : ""}`}>{basename(file.path)}</span>
                <span className="result-dir">{dirname(file.path) === "/" ? "" : dirname(file.path)}</span>
                <span className="git-row-actions" onClick={(e) => e.stopPropagation()}>
                  {shown !== "D" && (
                    <button type="button" className="icon-button" title="Open File" onClick={() => props.onOpen(file)}>
                      <FileText size={13} />
                    </button>
                  )}
                  {isStaged ? (
                    <button type="button" className="icon-button" title="Unstage" onClick={() => props.onUnstage([file.path])}>
                      <Minus size={14} />
                    </button>
                  ) : (
                    <>
                      <button type="button" className="icon-button" title="Discard Changes" onClick={() => props.onDiscard([file])}>
                        <Undo2 size={13} />
                      </button>
                      <button type="button" className="icon-button" title="Stage" onClick={() => props.onStage([file.path])}>
                        <Plus size={14} />
                      </button>
                    </>
                  )}
                </span>
                <span className="tree-mark">{letter}</span>
              </div>
            );
          })}
      </div>
    );
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Source Control</span>
        <div className="panel-actions">
          <button type="button" className="icon-button" title="Refresh" onClick={props.onRefresh}>
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      <div className="git-bar">
        <button type="button" className="branch-button" title="Switch branch" onClick={props.onBranchMenu}>
          <GitBranch size={13} />
          <span>{status.branch ?? "detached HEAD"}</span>
        </button>
        <button
          type="button"
          className="sync-button"
          title={status.upstream ? `Pull and push with ${status.upstream}` : "Publish branch"}
          disabled={!!props.busy}
          onClick={props.onSync}
        >
          {props.busy ? <LoaderCircle size={13} className="spin" /> : null}
          {!props.busy && status.upstream && (
            <>
              <ArrowDown size={13} />
              {status.behind}
              <ArrowUp size={13} />
              {status.ahead}
            </>
          )}
          {!props.busy && !status.upstream && "Publish"}
        </button>
      </div>
      <div className="commit-box">
        <textarea
          value={message}
          placeholder={`Message (⌘↩ to commit on "${status.branch ?? "HEAD"}")`}
          rows={3}
          spellCheck={false}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) {
              e.preventDefault();
              void commit();
            }
          }}
        />
        <button type="button" className="button primary commit-button" disabled={!message.trim() || !!props.busy || status.files.length === 0} onClick={() => void commit()}>
          <Check size={14} /> Commit
        </button>
      </div>
      <div className="git-lists">
        {section("conflicts", "Merge Conflicts", conflicts, false)}
        {section("staged", "Staged Changes", staged.filter((f) => f.index !== "U"), true)}
        {section("changes", "Changes", changes.filter((f) => f.index !== "U"), false)}
        {status.files.length === 0 && <div className="panel-empty">No changes.</div>}
      </div>
    </div>
  );
}

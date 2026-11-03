import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, basename, type ClaudeSession, type SessionDetails } from "../api";
import { Claude, GitBranch, History, Trash2 } from "./icons";
import { ago, useNow } from "./Notifications";

const SCOPE_KEY = "lookout.historyScope";

type Scope = "folder" | "all";

/** "Today", "Yesterday", "This week" or "Earlier", for the group headings. */
function dayGroup(time: number, now: number): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (time >= today) return "Today";
  if (time >= today - 86_400_000) return "Yesterday";
  if (time >= today - 6 * 86_400_000) return "This week";
  return "Earlier";
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatCost(cost: number): string {
  return cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

interface HistoryProps {
  /** The window's folder, for the This folder filter. */
  folder: string | null;
  /** Conversations open in a tab here, by session id, with the tab's id. */
  openSessions: Map<string, string>;
  /** Changes to open the panel with the search focused (⌘Y). */
  openSignal: number;
  onResume: (session: ClaudeSession) => void;
  onActivate: (tabId: string) => void;
  onRenamed: (sessionId: string, name: string) => void;
  onError: (message: string) => void;
}

/** The history button in the title bar, with past Claude conversations below it to continue. */
export function HistoryButton(props: HistoryProps) {
  const [open, setOpen] = useState(false);
  /** The last list loaded; shown at once next time while it reloads. */
  const [sessions, setSessions] = useState<ClaudeSession[] | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>(() => (localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "folder"));
  /** The highlighted card, for the arrow keys and Enter. */
  const [index, setIndex] = useState(0);
  /** Deleted conversations sliding out of the list. */
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Details of conversations hovered, loaded once each. */
  const [details, setDetails] = useState<Map<string, SessionDetails | null>>(new Map());
  /** The card the details card is next to, and how far down it is. */
  const [peek, setPeek] = useState<{ id: string; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const peekTimer = useRef(0);
  const now = useNow();

  const folderScope = scope === "folder" && props.folder !== null;

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (sessions ?? []).filter((s) => {
      if (folderScope && s.cwd !== props.folder) return false;
      const text = `${s.title ?? ""} ${s.prompt ?? ""} ${s.cwd} ${s.branch ?? ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [sessions, query, folderScope, props.folder]);

  useEffect(() => setIndex(0), [query, scope]);

  // ⌘Y opens the panel, or focuses its search when it is open.
  const firstSignal = useRef(props.openSignal);
  useEffect(() => {
    if (props.openSignal === firstSignal.current) return;
    setOpen(true);
    requestAnimationFrame(() => search.current?.focus());
  }, [props.openSignal]);

  useEffect(() => {
    if (!open) {
      setPeek(null);
      setRenaming(null);
      return;
    }
    setLeaving(new Set());
    setQuery("");
    setDetails(new Map());
    void api.claudeSessions().then(setSessions, () => setSessions((s) => s ?? []));
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onBlur = () => setOpen(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  useEffect(() => {
    list.current?.querySelector(".notice-card.selected")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const changeScope = (next: Scope) => {
    setScope(next);
    try {
      localStorage.setItem(SCOPE_KEY, next);
    } catch {
      // Only a convenience; the toggle still works for this window.
    }
  };

  const pick = (session: ClaudeSession) => {
    setOpen(false);
    const tabId = props.openSessions.get(session.id);
    if (tabId) props.onActivate(tabId);
    else props.onResume(session);
  };

  /** Shows the details card next to a card after a moment, loading them the first time. */
  const hover = (session: ClaudeSession, card: HTMLElement | null) => {
    window.clearTimeout(peekTimer.current);
    if (!card || !ref.current) return setPeek(null);
    const top = card.getBoundingClientRect().top - ref.current.getBoundingClientRect().top;
    peekTimer.current = window.setTimeout(() => {
      setPeek({ id: session.id, top });
      if (!details.has(session.id)) {
        void api.claudeSessionDetails(session.id).then(
          (d) => setDetails((m) => new Map(m).set(session.id, d)),
          () => setDetails((m) => new Map(m).set(session.id, null)),
        );
      }
    }, 350);
  };

  const rename = (session: ClaudeSession, name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === session.title) return;
    api.claudeSessionRename(session.id, trimmed).then(
      () => {
        setSessions((l) => l?.map((s) => (s.id === session.id ? { ...s, title: trimmed } : s)) ?? null);
        props.onRenamed(session.id, trimmed);
      },
      (err) => props.onError(String(err)),
    );
  };

  const peeked = peek ? shown.find((s) => s.id === peek.id) : undefined;
  const peekDetails = peeked ? details.get(peeked.id) : undefined;

  const rows: ReactNode[] = [];
  let group = "";
  shown.forEach((session, i) => {
    const heading = dayGroup(session.modified, now);
    if (heading !== group) {
      group = heading;
      rows.push(
        <div key={`g-${heading}`} className="history-group">
          {heading}
        </div>,
      );
    }
    const isOpen = props.openSessions.has(session.id);
    const isLeaving = leaving.has(session.id);
    rows.push(
      <div
        key={session.id}
        className={`notice-row${isLeaving ? " leaving" : ""}`}
        style={{ "--i": isLeaving ? 0 : Math.min(i, 8) } as CSSProperties}
        onAnimationEnd={(e) => {
          if (e.animationName === "notice-collapse" && isLeaving) setSessions((l) => l?.filter((s) => s.id !== session.id) ?? null);
        }}
      >
        <div
          className={`notice-card claude history-card${i === index ? " selected" : ""}${isOpen ? " open" : ""}`}
          role="button"
          tabIndex={-1}
          onMouseEnter={(e) => {
            setIndex(i);
            hover(session, e.currentTarget);
          }}
          onMouseLeave={() => hover(session, null)}
          onClick={() => renaming !== session.id && pick(session)}
          onContextMenu={(e) => {
            e.preventDefault();
            setPeek(null);
            setRenaming(session.id);
          }}
        >
          <span className="notice-icon">
            <Claude size={15} />
          </span>
          <span className="notice-text">
            {renaming === session.id ? (
              <input
                className="history-rename"
                autoFocus
                defaultValue={session.title ?? session.prompt ?? ""}
                spellCheck={false}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => rename(session, e.currentTarget.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") rename(session, e.currentTarget.value);
                  else if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <span className="notice-title">{session.title ?? session.prompt}</span>
            )}
            {session.title && session.prompt && <span className="notice-body">{session.prompt}</span>}
            <span className="notice-meta">
              {isOpen && <span className="history-open-dot" title="Open in a tab" />}
              {folderScope ? "" : `${basename(session.cwd)} · `}
              {session.branch ? `${session.branch} · ` : ""}
              {ago(session.modified, now)}
            </span>
          </span>
          <button
            type="button"
            className="notice-dismiss"
            title="Delete conversation"
            onClick={(e) => {
              e.stopPropagation();
              setPeek(null);
              api.claudeSessionDelete(session.id).then(
                () => setLeaving((s) => new Set(s).add(session.id)),
                (err) => props.onError(String(err)),
              );
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>,
    );
  });

  return (
    <div className="notices" ref={ref}>
      <button
        type="button"
        className={`bell-button${open ? " open" : ""}`}
        title="Claude history (⌘Y)"
        aria-label="Claude history"
        onClick={() => setOpen((o) => !o)}
      >
        <History size={16} />
      </button>
      {open && (
        <div className="notice-panel history-panel" onContextMenu={(e) => e.preventDefault()}>
          <div className="notice-head">
            <span className="notice-heading">History</span>
            <div className="history-scope" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={folderScope}
                className={folderScope ? "active" : ""}
                disabled={!props.folder}
                title={props.folder ? `Only ${basename(props.folder)}` : "Open a folder first"}
                onClick={() => changeScope("folder")}
              >
                This folder
              </button>
              <button type="button" role="tab" aria-selected={!folderScope} className={folderScope ? "" : "active"} onClick={() => changeScope("all")}>
                All
              </button>
            </div>
          </div>
          <div className="history-search">
            <input
              ref={search}
              autoFocus
              value={query}
              placeholder="Search conversations"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setIndex((i) => Math.min(shown.length - 1, i + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setIndex((i) => Math.max(0, i - 1));
                } else if (e.key === "Enter" && shown[index]) {
                  e.preventDefault();
                  pick(shown[index]);
                }
              }}
            />
          </div>
          {sessions === null ? null : shown.length === 0 ? (
            <div className="notice-empty">
              <span className="notice-empty-icon">
                <History size={22} />
              </span>
              <span className="notice-empty-title">{query ? "No matches" : "No conversations"}</span>
              <span className="notice-empty-text">
                {query
                  ? "No conversation has those words in its name, first message, folder or branch."
                  : folderScope
                    ? "Claude Code conversations in this folder show up here. All shows the other folders."
                    : "Claude Code conversations show up here, so you can continue one later."}
              </span>
            </div>
          ) : (
            <div className="notice-list" ref={list} onScroll={() => setPeek(null)}>
              {rows}
            </div>
          )}
          <div className="history-foot">Enter opens · right-click renames</div>
        </div>
      )}
      {open && peeked && (
        <div className="history-peek" style={{ top: peek!.top }}>
          <span className="history-peek-title">{peeked.title ?? peeked.prompt}</span>
          <span className="history-peek-path">{peeked.cwd}</span>
          {peekDetails === undefined ? (
            <span className="history-peek-muted">Reading…</span>
          ) : peekDetails === null ? (
            <span className="history-peek-muted">Could not read the conversation.</span>
          ) : (
            <>
              <span className="history-peek-stats">
                {peekDetails.branch && (
                  <span>
                    <GitBranch size={11} /> {peekDetails.branch}
                  </span>
                )}
                <span>{peekDetails.messages} messages</span>
                <span>{formatTokens(peekDetails.tokens)} tokens</span>
                {peekDetails.cost !== null && <span>{formatCost(peekDetails.cost)}</span>}
              </span>
              {peekDetails.lastReply && <span className="history-peek-reply">{peekDetails.lastReply}</span>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

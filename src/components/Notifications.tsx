import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, type NewNotice, type Notice, type NoticeKind } from "../api";
import { Bell, BrushCleaning, CircleCheck, CircleX, MessageBell, Sparkle, X } from "./icons";
import type { TerminalEvent } from "./TerminalView";

/** Commands that run at least this long get a notification when they end. */
const LONG_COMMAND_SECONDS = 10;

/** Programs people use interactively; quitting one is not worth a notification. */
const INTERACTIVE = new Set([
  "claude", "vim", "nvim", "vi", "nano", "emacs", "less", "more", "man", "top", "htop", "btop",
  "ssh", "mosh", "tmux", "screen", "watch", "fzf", "lazygit", "tig", "python", "python3", "node",
  "irb", "psql", "mysql", "sqlite3", "bash", "zsh", "fish", "sh",
]);

/** The program a command line runs, past variable assignments and sudo. */
function program(line: string): string {
  for (const word of line.trim().split(/\s+/)) {
    if (/^\w+=/.test(word) || ["sudo", "time", "command", "exec", "nohup"].includes(word)) continue;
    return word.split("/").pop() ?? word;
  }
  return "";
}

function duration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The notification for something that happened in a terminal, or null. */
export async function noticeFor(event: TerminalEvent, tabTitle: string): Promise<Pick<NewNotice, "kind" | "title" | "body"> | null> {
  if (event.type === "command") {
    if (event.seconds < LONG_COMMAND_SECONDS || event.exitCode === 130 || INTERACTIVE.has(program(event.line))) return null;
    const ok = event.exitCode === 0;
    return {
      kind: ok ? "done" : "failed",
      title: event.line,
      body: ok ? `Finished in ${duration(event.seconds)}` : `Failed with exit code ${event.exitCode} after ${duration(event.seconds)}`,
    };
  }
  if (event.type === "claude") {
    const hook = event.hook;
    if (hook.hook_event_name === "Stop") {
      if (hook.stop_hook_active) return null;
      const reply = hook.transcript_path ? await api.claudeReply(hook.transcript_path).catch(() => null) : null;
      return { kind: "claude", title: "Claude finished", body: reply ?? "Ready for your next message" };
    }
    if (hook.hook_event_name === "Notification") {
      // Claude also sends one after a minute of waiting; "Claude finished" already said so.
      if (hook.notification_type === "idle_prompt" || /waiting for your input/i.test(hook.message ?? "")) return null;
      return { kind: "claude-input", title: "Claude needs your input", body: hook.message ?? "" };
    }
    return null;
  }
  return { kind: "message", title: event.title || tabTitle, body: event.body };
}

const ICONS: Record<NoticeKind, ReactNode> = {
  claude: <Sparkle size={15} />,
  "claude-input": <MessageBell size={15} />,
  done: <CircleCheck size={15} />,
  failed: <CircleX size={15} />,
  message: <Bell size={15} />,
};

function ago(time: number, now: number): string {
  const s = Math.max(0, (now - time) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Re-renders every 30 seconds, for times like "4m". */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function NoticeCard(props: { notice: Notice; fresh: boolean; now: number; onOpen: () => void; onDismiss: () => void; children?: ReactNode }) {
  const { notice } = props;
  return (
    <div className={`notice-card ${notice.kind}${props.fresh ? " fresh" : ""}`} role="button" tabIndex={0} onClick={props.onOpen}>
      <span className="notice-icon">{ICONS[notice.kind]}</span>
      <span className="notice-text">
        <span className="notice-title">{notice.title}</span>
        {notice.body && <span className="notice-body">{notice.body}</span>}
        <span className="notice-meta">
          {notice.tabTitle} · {ago(notice.time, props.now)}
        </span>
      </span>
      <button
        type="button"
        className="notice-dismiss"
        title="Dismiss"
        onClick={(e) => {
          e.stopPropagation();
          props.onDismiss();
        }}
      >
        <X size={12} />
      </button>
      {props.children}
    </div>
  );
}

/** The bell in the title bar, with the notifications of all windows below it. */
export function NotificationBell(props: { notices: Notice[]; onOpen: (notice: Notice) => void }) {
  const [open, setOpen] = useState(false);
  /** Unread when the panel opened; they keep their mark while it stays open. */
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [leaving, setLeaving] = useState<Set<number>>(new Set());
  const [clearing, setClearing] = useState(false);
  const [ringing, setRinging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow();
  const unread = props.notices.filter((n) => !n.read).length;

  // The bell swings when a new notification comes in.
  const before = useRef(unread);
  useEffect(() => {
    if (unread > before.current) {
      setRinging(true);
      const timer = setTimeout(() => setRinging(false), 900);
      before.current = unread;
      return () => clearTimeout(timer);
    }
    before.current = unread;
  }, [unread]);

  useEffect(() => {
    if (!open) return;
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

  const toggle = () => {
    if (open) return setOpen(false);
    setFresh(new Set(props.notices.filter((n) => !n.read).map((n) => n.id)));
    setLeaving(new Set());
    setClearing(false);
    setOpen(true);
    if (unread) void api.noticesRead();
  };

  const clearAll = () => {
    setClearing(true);
    // The cards leave one after another, then the list empties.
    setTimeout(() => void api.noticesClear().then(() => setClearing(false)), Math.min(props.notices.length, 8) * 35 + 260);
  };

  return (
    <div className="notices" ref={ref}>
      <button
        type="button"
        className={`bell-button${open ? " open" : ""}${ringing ? " ringing" : ""}`}
        title={unread ? `${unread} new ${unread === 1 ? "notification" : "notifications"}` : "Notifications"}
        aria-label="Notifications"
        onClick={toggle}
      >
        <Bell size={16} />
        {unread > 0 && (
          <span key={unread} className="bell-badge">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="notice-panel" onContextMenu={(e) => e.preventDefault()}>
          <div className="notice-head">
            <span className="notice-heading">Notifications</span>
            {props.notices.length > 0 && (
              <button type="button" className="notice-clear" onClick={clearAll} disabled={clearing}>
                <BrushCleaning size={13} /> Clear all
              </button>
            )}
          </div>
          {props.notices.length === 0 ? (
            <div className="notice-empty">
              <span className="notice-empty-icon">
                <Bell size={22} />
              </span>
              <span className="notice-empty-title">No notifications</span>
              <span className="notice-empty-text">Claude finishing or needing you, and commands that ran for 10 seconds or more, show up here.</span>
            </div>
          ) : (
            <div className="notice-list">
              {props.notices.map((notice, i) => (
                <div
                  key={notice.id}
                  className={`notice-row${leaving.has(notice.id) || clearing ? " leaving" : ""}`}
                  style={{ "--i": Math.min(i, 8) } as CSSProperties}
                  onAnimationEnd={(e) => {
                    if (e.animationName === "notice-collapse" && leaving.has(notice.id)) void api.noticeRemove(notice.id);
                  }}
                >
                  <NoticeCard
                    notice={notice}
                    fresh={fresh.has(notice.id)}
                    now={now}
                    onOpen={() => {
                      setOpen(false);
                      props.onOpen(notice);
                    }}
                    onDismiss={() => setLeaving((s) => new Set(s).add(notice.id))}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Notifications that pop up under the bell for a moment, for tabs that are not in view. */
export function NoticePeeks(props: { peeks: Notice[]; onOpen: (notice: Notice) => void; onDone: (id: number) => void }) {
  const [leaving, setLeaving] = useState<Set<number>>(new Set());
  const now = useNow();
  const leave = (id: number) => setLeaving((s) => new Set(s).add(id));
  return (
    <div className="notice-peeks">
      {props.peeks.map((notice) => (
        <div
          key={notice.id}
          className={`notice-peek${leaving.has(notice.id) ? " leaving" : ""}`}
          onAnimationEnd={(e) => {
            if (e.animationName === "peek-out") {
              setLeaving((s) => {
                const next = new Set(s);
                next.delete(notice.id);
                return next;
              });
              props.onDone(notice.id);
            }
          }}
        >
          <NoticeCard
            notice={notice}
            fresh
            now={now}
            onOpen={() => {
              props.onOpen(notice);
              leave(notice.id);
            }}
            onDismiss={() => leave(notice.id)}
          >
            {/* Runs down while the card shows and pauses while the pointer is on it. */}
            <span className="notice-timer" onAnimationEnd={() => leave(notice.id)} />
          </NoticeCard>
        </div>
      ))}
    </div>
  );
}

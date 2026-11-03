import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api, type ListeningPort } from "../api";
import { ExternalLink, Server } from "./icons";

/** How often the terminals are checked for servers. */
const POLL_MS = 4000;

/** Local servers running in this window's terminals, in the title bar. Hidden while there are none. */
export function PortsButton(props: {
  /** Terminal sessions in this window, by session id, with their tab's id and title. */
  sessions: Map<string, { tabId: string; title: string }>;
  onShowTab: (tabId: string) => void;
}) {
  const [ports, setPorts] = useState<ListeningPort[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      const all = await api.listeningPorts().catch(() => []);
      if (stopped) return;
      const mine = all.filter((p) => latest.current.sessions.has(p.sessionId));
      setPorts((before) => (JSON.stringify(before) === JSON.stringify(mine) ? before : mine));
    };
    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

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

  useEffect(() => {
    if (ports.length === 0) setOpen(false);
  }, [ports.length]);

  if (ports.length === 0) return null;
  const tip = `${ports.length} local ${ports.length === 1 ? "server" : "servers"}: ${ports.map((p) => p.port).join(", ")}`;

  return (
    <div className="notices" ref={ref}>
      <button type="button" className={`bell-button ports-button${open ? " open" : ""}`} title={tip} aria-label={tip} onClick={() => setOpen((o) => !o)}>
        <Server size={16} />
        <span key={ports.length} className="ports-count">
          {ports.length}
        </span>
      </button>
      {open && (
        <div className="notice-panel ports-panel" onContextMenu={(e) => e.preventDefault()}>
          <div className="notice-head">
            <span className="notice-heading">Local servers</span>
          </div>
          <div className="notice-list">
            {ports.map((port, i) => {
              const tab = props.sessions.get(port.sessionId);
              return (
                <div key={port.port} className="notice-row" style={{ "--i": Math.min(i, 8) } as CSSProperties}>
                  <div
                    className="notice-card port-card"
                    role="button"
                    tabIndex={0}
                    title={`Open http://localhost:${port.port}`}
                    onClick={() => {
                      setOpen(false);
                      void openUrl(`http://localhost:${port.port}`);
                    }}
                  >
                    <span className="notice-icon">
                      <ExternalLink size={14} />
                    </span>
                    <span className="notice-text">
                      <span className="notice-title">localhost:{port.port}</span>
                      <span className="notice-meta">
                        {port.process} · pid {port.pid}
                        {tab ? ` · ${tab.title}` : ""}
                      </span>
                    </span>
                    {tab && (
                      <button
                        type="button"
                        className="port-tab"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpen(false);
                          props.onShowTab(tab.tabId);
                        }}
                      >
                        Show tab
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

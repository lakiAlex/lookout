import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Tab } from "../lib/tabs";
import { AppWindow, X } from "./icons";

/** A tab dragged this far below the tab bar, or out of the window, opens in a new window. */
const TEAR_DISTANCE = 44;

interface Drag {
  id: string;
  x: number;
  y: number;
  /** Where the pointer holds the tab, from its left edge. */
  grab: number;
  /** Far enough out to open a new window on release. */
  out: boolean;
}

interface TabBarProps {
  tabs: Tab[];
  activeId: string | null;
  label: (tab: Tab) => { icon: ReactNode; text: string };
  /** A tab can leave only when another one stays. */
  canTearOff: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onPin: (id: string) => void;
  onMenu: (e: ReactMouseEvent, tab: Tab) => void;
  /** Puts the tab at `index` among the other tabs. */
  onMove: (id: string, index: number) => void;
  /** Dropped outside: open it in a new window there, in screen points. */
  onTearOff: (id: string, screenX: number, screenY: number) => void;
  children: ReactNode;
}

/** The tabs in the title bar. Drag a tab to reorder it, or out of the bar to
 * give it its own window. */
export function TabBar(props: TabBarProps) {
  const strip = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const latest = useRef(props);
  latest.current = props;

  // Tabs that change place slide there: each starts at its old spot and moves to the new one.
  const lefts = useRef(new Map<string, number>());
  const order = props.tabs.map((t) => t.id).join(" ");
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    for (const [id, el] of elements.current) {
      next.set(id, el.offsetLeft);
      const before = lefts.current.get(id);
      if (before === undefined || before === el.offsetLeft || id === dragRef.current?.id) continue;
      el.style.transition = "none";
      el.style.transform = `translateX(${before - el.offsetLeft}px)`;
      void el.offsetWidth;
      el.style.transition = "";
      el.style.transform = "";
    }
    lefts.current = next;
  }, [order]);

  // The dragged tab follows the pointer along the bar.
  useLayoutEffect(() => {
    if (!drag || drag.out) return;
    const el = elements.current.get(drag.id);
    const bar = strip.current;
    if (!el || !bar) return;
    const left = bar.getBoundingClientRect().left + el.offsetLeft - bar.scrollLeft;
    el.style.transition = "none";
    el.style.transform = `translateX(${drag.x - drag.grab - left}px)`;
  });

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>, tab: Tab) => {
    if (e.button === 1) {
      e.preventDefault();
      props.onClose(tab.id);
      return;
    }
    if (e.button !== 0) return;
    props.onActivate(tab.id);
    const el = e.currentTarget;
    const start = { x: e.clientX, y: e.clientY };
    const grab = e.clientX - el.getBoundingClientRect().left;
    const barBottom = strip.current?.getBoundingClientRect().bottom ?? 38;
    let moved = false;
    let screen = { x: e.screenX, y: e.screenY };
    el.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      screen = { x: ev.screenX, y: ev.screenY };
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      moved = true;
      const outside = ev.clientY > barBottom + TEAR_DISTANCE || ev.clientY < 0 || ev.clientX < 0 || ev.clientX > window.innerWidth;
      const out = latest.current.canTearOff && outside;
      if (!out) {
        // The place among the other tabs: before the first whose middle is right of the pointer.
        const others = latest.current.tabs.filter((t) => t.id !== tab.id);
        let index = others.findIndex((t) => {
          const r = elements.current.get(t.id)?.getBoundingClientRect();
          return r ? ev.clientX < r.left + r.width / 2 : false;
        });
        if (index < 0) index = others.length;
        if (latest.current.tabs.findIndex((t) => t.id === tab.id) !== index) latest.current.onMove(tab.id, index);
      }
      setDrag({ id: tab.id, x: ev.clientX, y: ev.clientY, grab, out });
    };
    const finish = (drop: boolean) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("lostpointercapture", lost);
      const out = dragRef.current?.out;
      // Back to its place in the bar, sliding.
      el.style.transition = "";
      el.style.transform = "";
      setDrag(null);
      if (moved && drop && out) latest.current.onTearOff(tab.id, screen.x, screen.y);
    };
    const up = (ev: PointerEvent) => {
      screen = { x: ev.screenX, y: ev.screenY };
      finish(true);
    };
    // Released outside the window, where the web view may not get the pointerup.
    const lost = () => finish(true);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("lostpointercapture", lost);
  };

  const dragged = drag ? props.tabs.find((t) => t.id === drag.id) : undefined;

  return (
    <div className={`tabs${drag ? " dragging" : ""}`} ref={strip} data-tauri-drag-region>
      {props.tabs.map((tab) => {
        const { icon, text } = props.label(tab);
        const dirty = tab.kind === "file" && tab.dirty;
        const lifted = drag?.id === tab.id;
        return (
          <div
            key={tab.id}
            ref={(el) => {
              if (el) elements.current.set(tab.id, el);
              else elements.current.delete(tab.id);
            }}
            className={`tab${tab.id === props.activeId ? " active" : ""}${tab.kind === "file" && tab.preview ? " preview" : ""}${lifted ? (drag.out ? " torn" : " lifted") : ""}`}
            title={tab.kind === "file" ? tab.path : tab.kind === "diff" ? tab.path : undefined}
            onPointerDown={(e) => startDrag(e, tab)}
            onDoubleClick={() => props.onPin(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              props.onMenu(e, tab);
            }}
          >
            <span className="tab-icon">{icon}</span>
            <span className="tab-text">{text}</span>
            <button
              type="button"
              className={`tab-close${dirty ? " dirty" : ""}`}
              title="Close (⌘W)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => props.onClose(tab.id)}
            >
              <span className="tab-dot" />
              <X size={12} />
            </button>
          </div>
        );
      })}
      {props.children}
      {drag?.out && dragged && (
        <div
          className="tab-ghost"
          style={{ left: Math.min(Math.max(drag.x - 24, 8), window.innerWidth - 228), top: Math.min(Math.max(drag.y - 14, 8), window.innerHeight - 64) }}
        >
          <span className="tab-ghost-bar">
            <span className="tab-icon">{props.label(dragged).icon}</span>
            <span className="tab-text">{props.label(dragged).text}</span>
          </span>
          <span className="tab-ghost-hint">
            <AppWindow size={12} /> Release for a new window
          </span>
        </div>
      )}
    </div>
  );
}

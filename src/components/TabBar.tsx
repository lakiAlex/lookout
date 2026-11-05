import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { MAX_PANES } from "../lib/layout";
import type { ClaudeState, Tab } from "../lib/tabs";
import { AppWindow, Split, X } from "./icons";

/** What letting go of a tab dragged out of its bar does: open it in a new
 * window, split the group under the pointer, move it into another group, or
 * nothing ("full" when the window has no room for another group). */
export type DragMode = "out" | "split" | "move" | "full" | "none";

interface Drag {
  id: string;
  x: number;
  y: number;
  /** Where the pointer holds the tab, from its left edge. */
  grab: number;
  /** Out of the bar: what a drop there does. Null while over the bar, where the tab moves along. */
  mode: DragMode | null;
}

interface TabBarProps {
  /** The tabs of this group, in order. */
  tabs: Tab[];
  /** The tab shown in this group. */
  activeId: string | null;
  /** The group has the keyboard. */
  focused: boolean;
  /** A tab dragged from another group goes in before this index. */
  dropIndex: number | null;
  label: (tab: Tab) => { icon: ReactNode; text: string };
  /** What Claude is doing in a terminal tab, for the dot on tabs not in view. */
  status: (tab: Tab) => ClaudeState | undefined;
  /** The tooltip of a terminal tab. */
  tip: (tab: Tab) => string | undefined;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onPin: (id: string) => void;
  onMenu: (e: ReactMouseEvent, tab: Tab) => void;
  /** Puts the tab at `index` among the other tabs of the group. */
  onMove: (id: string, index: number) => void;
  /** Dragged out of the bar, at x, y in the window: says what a drop there does.
   * Null x and y: back over the bar. */
  onDragOver: (id: string, x: number | null, y: number | null) => DragMode;
  /** Let go. With `drop`, the tab goes where onDragOver said; screen points for a new window. */
  onDragEnd: (id: string, drop: boolean, screenX: number, screenY: number) => void;
  barRef?: (el: HTMLDivElement | null) => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/** The tabs of one group. Drag a tab along the bar to reorder it, onto
 * another group's tabs or terminal to move it there, onto an edge of a group to
 * split it, or out of the window to give it its own window. */
export function TabBar(props: TabBarProps) {
  const strip = useRef<HTMLDivElement | null>(null);
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
    if (!drag || drag.mode !== null) return;
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
    let moved = false;
    let screen = { x: e.screenX, y: e.screenY };
    el.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      screen = { x: ev.screenX, y: ev.screenY };
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      moved = true;
      const bar = strip.current?.getBoundingClientRect();
      const overBar = !!bar && ev.clientX >= bar.left && ev.clientX <= bar.right && ev.clientY >= bar.top - 8 && ev.clientY <= bar.bottom + 12;
      let mode: DragMode | null = null;
      if (overBar) {
        if (dragRef.current?.mode) latest.current.onDragOver(tab.id, null, null);
        // The place among the other tabs: before the first whose middle is right of the pointer.
        const others = latest.current.tabs.filter((t) => t.id !== tab.id);
        let index = others.findIndex((t) => {
          const r = elements.current.get(t.id)?.getBoundingClientRect();
          return r ? ev.clientX < r.left + r.width / 2 : false;
        });
        if (index < 0) index = others.length;
        if (latest.current.tabs.findIndex((t) => t.id === tab.id) !== index) latest.current.onMove(tab.id, index);
      } else {
        mode = latest.current.onDragOver(tab.id, ev.clientX, ev.clientY);
      }
      setDrag({ id: tab.id, x: ev.clientX, y: ev.clientY, grab, mode });
    };
    const finish = (drop: boolean) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("lostpointercapture", lost);
      const mode = dragRef.current?.mode ?? null;
      // Back to its place in the bar, sliding.
      el.style.transition = "";
      el.style.transform = "";
      setDrag(null);
      latest.current.onDragEnd(tab.id, moved && drop && mode !== null, screen.x, screen.y);
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
  const hint: Record<DragMode, ReactNode> = {
    out: (
      <>
        <AppWindow size={12} /> Release for a new window
      </>
    ),
    split: (
      <>
        <Split size={12} /> Release to split
      </>
    ),
    move: (
      <>
        <Split size={12} /> Release to move here
      </>
    ),
    full: (
      <>
        <Split size={12} /> A window splits into {MAX_PANES} at most
      </>
    ),
    none: null,
  };

  return (
    <div
      className={`tabs${drag ? " dragging" : ""}${props.focused ? " focused" : ""}${props.className ? ` ${props.className}` : ""}`}
      style={props.style}
      ref={(el) => {
        strip.current = el;
        props.barRef?.(el);
      }}
      data-tauri-drag-region
    >
      {props.tabs.map((tab, i) => {
        const { icon, text } = props.label(tab);
        const dirty = tab.kind === "file" && tab.dirty;
        const lifted = drag?.id === tab.id;
        const status = tab.id === props.activeId ? undefined : props.status(tab);
        return (
          <div
            key={tab.id}
            ref={(el) => {
              if (el) elements.current.set(tab.id, el);
              else elements.current.delete(tab.id);
            }}
            className={`tab${tab.id === props.activeId ? " active" : ""}${tab.kind === "file" && tab.preview ? " preview" : ""}${lifted ? (drag.mode !== null ? " torn" : " lifted") : ""}${props.dropIndex === i ? " drop-before" : ""}${props.dropIndex !== null && props.dropIndex >= props.tabs.length && i === props.tabs.length - 1 ? " drop-after" : ""}`}
            title={tab.kind === "file" ? tab.path : tab.kind === "diff" ? tab.path : props.tip(tab)}
            onPointerDown={(e) => startDrag(e, tab)}
            onDoubleClick={() => props.onPin(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              props.onMenu(e, tab);
            }}
          >
            <span className="tab-icon">
              {icon}
              {status && <span key={status} className={`tab-status ${status}`} />}
            </span>
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
      {drag?.mode && dragged && (
        <div
          className="tab-ghost"
          style={{ left: Math.min(Math.max(drag.x - 24, 8), window.innerWidth - 228), top: Math.min(Math.max(drag.y - 14, 8), window.innerHeight - 64) }}
        >
          <span className="tab-ghost-bar">
            <span className="tab-icon">{props.label(dragged).icon}</span>
            <span className="tab-text">{props.label(dragged).text}</span>
          </span>
          {hint[drag.mode] && <span className="tab-ghost-hint">{hint[drag.mode]}</span>}
        </div>
      )}
    </div>
  );
}

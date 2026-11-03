import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ChevronRight, FilePlus2, FolderPlus, ListCollapse, RefreshCw } from "./icons";
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { api, basename, dirname, relative, toAppError, type Entry } from "../api";
import { iconUrl } from "../icons";
import { PanelClose } from "./PanelClose";

export interface GitMark {
  letter: string;
  kind: "modified" | "added" | "deleted" | "untracked" | "conflict" | "renamed";
}

type Editing = { kind: "file" | "folder"; dir: string } | { kind: "rename"; entry: Entry } | null;

interface FilesPanelProps {
  root: string;
  onClose: () => void;
  /** Git marks by path relative to the root. */
  marks: Map<string, GitMark>;
  activePath: string | null;
  onOpen: (path: string, pin: boolean) => void;
  /** `entries` are the selected files and folders the menu is for, empty for the tree's background. */
  onMenu: (e: ReactMouseEvent, entries: Entry[], actions: { newFile: () => void; newFolder: () => void; rename: () => void }) => void;
  /** ⌘⌫ on the selection. */
  onTrash: (entries: Entry[]) => void;
  /** Files and folders moved by dragging, as [old path, new path]. */
  onMoved: (moves: [string, string][]) => void;
  onError: (message: string) => void;
}

/** A folder that contains a changed file gets the strongest mark of its contents. */
function folderMark(marks: Map<string, GitMark>, rel: string): GitMark | null {
  const prefix = rel + "/";
  let found: GitMark | null = null;
  for (const [path, mark] of marks) {
    if (!path.startsWith(prefix)) continue;
    if (mark.kind === "conflict") return mark;
    if (!found || mark.kind === "modified") found = mark;
  }
  return found ? { letter: "•", kind: found.kind } : null;
}

/** The label that follows the pointer while files are dragged. */
type Ghost = { label: string; x: number; y: number };

export function FilesPanel(props: FilesPanelProps) {
  const { root } = props;
  const [children, setChildren] = useState<Map<string, Entry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root]));
  const [editing, setEditing] = useState<Editing>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Where ⇧-click ranges start: the last row clicked without ⇧. */
  const anchor = useRef<string | null>(null);
  /** The folder that a drag would drop into. */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  /** A drag ended on a row; the click that follows is not a click. */
  const dragged = useRef(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const latest = useRef(props);
  latest.current = props;

  const load = useCallback(
    async (dir: string) => {
      try {
        const list = await api.listDir(dir);
        setChildren((m) => new Map(m).set(dir, list));
      } catch (e) {
        // A folder that went away just disappears from the tree.
        setChildren((m) => {
          const next = new Map(m);
          next.delete(dir);
          return next;
        });
        if (dir === root) props.onError(toAppError(e).message);
      }
    },
    [root],
  );

  useEffect(() => {
    setChildren(new Map());
    setExpanded(new Set([root]));
    setSelected(new Set());
    void load(root);
  }, [root, load]);

  // Folders whose contents changed on disk are listed again if they are open.
  useEffect(() => {
    // This window's folder only; other windows watch their own.
    const un = getCurrentWebviewWindow().listen<string[]>("fs-changed", (event) => {
      for (const dir of event.payload) if (expandedRef.current.has(dir)) void load(dir);
    });
    return () => void un.then((f) => f());
  }, [load]);

  // Reveal the active file: open the folders above it.
  useEffect(() => {
    const path = props.activePath;
    if (!path || !path.startsWith(root + "/")) return;
    setSelected((s) => (s.has(path) ? s : new Set([path])));
    anchor.current = path;
    const missing: string[] = [];
    for (let dir = dirname(path); dir.length > root.length; dir = dirname(dir)) missing.push(dir);
    if (missing.every((d) => expandedRef.current.has(d))) return;
    setExpanded((s) => new Set([...s, ...missing]));
    for (const dir of missing) if (!children.has(dir)) void load(dir);
  }, [props.activePath]);

  const open = (dir: string) => {
    setExpanded((s) => new Set(s).add(dir));
    void load(dir);
  };

  const toggle = (entry: Entry) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(entry.path)) next.delete(entry.path);
      else {
        next.add(entry.path);
        void load(entry.path);
      }
      return next;
    });
  };

  const startNew = (kind: "file" | "folder", dir: string) => {
    setExpanded((s) => new Set(s).add(dir));
    if (!children.has(dir)) void load(dir);
    setName("");
    setEditing({ kind, dir });
  };

  const commitEditing = async () => {
    const value = name.trim();
    const current = editing;
    setEditing(null);
    if (!current || !value) return;
    try {
      if (current.kind === "rename") {
        if (value === current.entry.name) return;
        await api.renamePath(current.entry.path, `${dirname(current.entry.path)}/${value}`);
        void load(dirname(current.entry.path));
      } else {
        const path = `${current.dir}/${value}`;
        await api.createPath(path, current.kind === "folder");
        void load(current.dir);
        if (current.kind === "file") props.onOpen(path, true);
      }
    } catch (e) {
      props.onError(toAppError(e).message);
    }
  };

  // ---- Drag and drop ----

  /** The folder under a point in the tree: a folder row, the folder of a file
   * row, or the root on the tree's empty space. Null outside the tree. */
  const folderAt = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    if (!el || !treeRef.current?.contains(el)) return null;
    const row = el.closest<HTMLElement>("[data-path]");
    if (!row) return root;
    const path = row.dataset.path!;
    return row.dataset.dir === "1" ? path : dirname(path);
  };

  /** Items can go into `dir` unless it is one of them or inside one. */
  const canDrop = (paths: string[], dir: string) => paths.every((p) => dir !== p && !dir.startsWith(p + "/"));

  const moveInto = async (paths: string[], dir: string) => {
    try {
      const moves = await api.movePaths(paths, dir);
      if (!moves.length) return;
      open(dir);
      for (const from of new Set(moves.map(([from]) => dirname(from)))) void load(from);
      setSelected(new Set(moves.map(([, to]) => to)));
      latest.current.onMoved(moves);
    } catch (e) {
      latest.current.onError(toAppError(e).message);
    }
  };

  // Files dragged in from Finder or another app are copied into the folder they are dropped on.
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((event) => {
      const drop = event.payload;
      if (drop.type === "leave") return setDropTarget(null);
      const dir = folderAt(drop.position.x / window.devicePixelRatio, drop.position.y / window.devicePixelRatio);
      if (drop.type !== "drop") return setDropTarget(dir);
      setDropTarget(null);
      if (!dir || !drop.paths.length) return;
      void api.copyPaths(drop.paths, dir).then(
        (copied) => {
          open(dir);
          setSelected(new Set(copied));
        },
        (e) => latest.current.onError(toAppError(e).message),
      );
    });
    return () => void un.then((f) => f());
  }, [root]);

  // Rows dragged inside the tree move into the folder they are dropped on.
  const startDrag = (e: ReactPointerEvent, entry: Entry) => {
    if (e.button !== 0 || e.metaKey || e.shiftKey || editing) return;
    const start = { x: e.clientX, y: e.clientY };
    let paths: string[] | null = null;
    let target: string | null = null;
    const move = (ev: PointerEvent) => {
      if (!paths) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
        paths = selected.has(entry.path) ? [...selected] : [entry.path];
        if (!selected.has(entry.path)) setSelected(new Set([entry.path]));
      }
      const dir = folderAt(ev.clientX, ev.clientY);
      target = dir && canDrop(paths, dir) ? dir : null;
      setDropTarget(target);
      setGhost({ label: paths.length === 1 ? basename(paths[0]) : `${paths.length} items`, x: ev.clientX, y: ev.clientY });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!paths) return;
      dragged.current = true;
      setTimeout(() => (dragged.current = false), 0);
      setDropTarget(null);
      setGhost(null);
      if (target) void moveInto(paths, target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---- Rows ----

  const nameInput = (depth: number, icon: string) => (
    <div className="tree-row editing" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="tree-chevron" />
      <img className="tree-icon" src={icon} alt="" />
      <input
        autoFocus
        className="tree-input"
        value={name}
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => {
          // Select the name without the extension, as Finder does.
          const dot = e.currentTarget.value.lastIndexOf(".");
          e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length);
        }}
        onBlur={() => void commitEditing()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commitEditing();
          else if (e.key === "Escape") setEditing(null);
        }}
      />
    </div>
  );

  /** Rows in the order shown, for ⇧-click ranges and ⌘A. */
  const visible: Entry[] = [];
  const rows: ReactNode[] = [];
  const walk = (dir: string, depth: number, ignoredParent: boolean) => {
    if (editing && editing.kind !== "rename" && editing.dir === dir) {
      rows.push(<div key={`new:${dir}`}>{nameInput(depth, iconUrl(name || "file", editing.kind === "folder"))}</div>);
    }
    for (const entry of children.get(dir) ?? []) {
      const isOpen = entry.dir && expanded.has(entry.path);
      const rel = relative(root, entry.path);
      const mark = entry.dir ? folderMark(props.marks, rel) : props.marks.get(rel) ?? null;
      const ignored = ignoredParent || entry.ignored;
      visible.push(entry);
      if (editing?.kind === "rename" && editing.entry.path === entry.path) {
        rows.push(<div key={entry.path}>{nameInput(depth, iconUrl(entry.name, entry.dir, isOpen))}</div>);
      } else {
        rows.push(
          <div
            key={entry.path}
            data-path={entry.path}
            data-dir={entry.dir ? "1" : "0"}
            className={`tree-row${selected.has(entry.path) ? " selected" : ""}${dropTarget === entry.path ? " drop-target" : ""}${ignored ? " ignored" : ""}${mark ? ` git-${mark.kind}` : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={rel}
            onPointerDown={(e) => startDrag(e, entry)}
            onClick={(e) => {
              if (dragged.current) return;
              if (e.metaKey) {
                // ⌘-click adds the row to the selection, or takes it out.
                setSelected((s) => {
                  const next = new Set(s);
                  if (next.has(entry.path)) next.delete(entry.path);
                  else next.add(entry.path);
                  return next;
                });
                anchor.current = entry.path;
                return;
              }
              if (e.shiftKey && anchor.current) {
                // ⇧-click selects every row from the last clicked one to this one.
                const from = visible.findIndex((v) => v.path === anchor.current);
                const to = visible.findIndex((v) => v.path === entry.path);
                if (from >= 0 && to >= 0) {
                  setSelected(new Set(visible.slice(Math.min(from, to), Math.max(from, to) + 1).map((v) => v.path)));
                  return;
                }
              }
              setSelected(new Set([entry.path]));
              anchor.current = entry.path;
              if (entry.dir) toggle(entry);
              else props.onOpen(entry.path, false);
            }}
            onDoubleClick={(e) => !entry.dir && !e.metaKey && !e.shiftKey && props.onOpen(entry.path, true)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // A right-click in the selection is for all of it; elsewhere it selects that row.
              const many = selected.has(entry.path) && selected.size > 1;
              if (!many) setSelected(new Set([entry.path]));
              const entries = many ? visible.filter((v) => selected.has(v.path)) : [entry];
              const dirOfEntry = entry.dir ? entry.path : dirname(entry.path);
              props.onMenu(e, entries, {
                newFile: () => startNew("file", dirOfEntry),
                newFolder: () => startNew("folder", dirOfEntry),
                rename: () => {
                  setName(entry.name);
                  setEditing({ kind: "rename", entry });
                },
              });
            }}
          >
            <span className={`tree-chevron${isOpen ? " open" : ""}`}>{entry.dir && <ChevronRight size={13} />}</span>
            <img className="tree-icon" src={iconUrl(entry.name, entry.dir, isOpen)} alt="" draggable={false} />
            <span className="tree-name">{entry.name}</span>
            {mark && <span className="tree-mark">{mark.letter}</span>}
          </div>,
        );
      }
      if (isOpen) walk(entry.path, depth + 1, ignored);
    }
  };
  walk(root, 0, false);

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title" title={root}>
          {basename(root)}
        </span>
        <div className="panel-actions">
          <button type="button" className="icon-button" title="New File" onClick={() => startNew("file", root)}>
            <FilePlus2 size={15} />
          </button>
          <button type="button" className="icon-button" title="New Folder" onClick={() => startNew("folder", root)}>
            <FolderPlus size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Refresh"
            onClick={() => {
              for (const dir of expanded) void load(dir);
            }}
          >
            <RefreshCw size={14} />
          </button>
          <button type="button" className="icon-button" title="Collapse Folders" onClick={() => setExpanded(new Set([root]))}>
            <ListCollapse size={15} />
          </button>
          <PanelClose onClose={props.onClose} />
        </div>
      </div>
      <div
        ref={treeRef}
        tabIndex={-1}
        className={`tree${dropTarget === root ? " drop-target" : ""}`}
        onKeyDown={(e) => {
          if (editing) return;
          if (e.metaKey && e.key.toLowerCase() === "a") {
            e.preventDefault();
            setSelected(new Set(visible.map((v) => v.path)));
          } else if (e.metaKey && e.key === "Backspace" && selected.size) {
            e.preventDefault();
            props.onTrash(visible.filter((v) => selected.has(v.path)));
          } else if (e.key === "Escape") {
            setSelected(new Set());
          }
        }}
        onClick={(e) => {
          // A click on the empty space below the rows clears the selection.
          if (e.target === e.currentTarget) setSelected(new Set());
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onMenu(e, [], {
            newFile: () => startNew("file", root),
            newFolder: () => startNew("folder", root),
            rename: () => undefined,
          });
        }}
      >
        {rows}
        {children.has(root) && (children.get(root)?.length ?? 0) === 0 && !editing && <div className="panel-empty">This folder is empty.</div>}
      </div>
      {ghost && (
        <div className="tree-ghost" style={{ left: ghost.x + 14, top: ghost.y + 10 }}>
          {ghost.label}
        </div>
      )}
    </div>
  );
}

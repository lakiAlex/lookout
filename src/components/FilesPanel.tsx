import { listen } from "@tauri-apps/api/event";
import { ChevronRight, FilePlus2, FolderPlus, ListCollapse, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { api, basename, dirname, relative, toAppError, type Entry } from "../api";
import { iconUrl } from "../icons";

export interface GitMark {
  letter: string;
  kind: "modified" | "added" | "deleted" | "untracked" | "conflict" | "renamed";
}

type Editing = { kind: "file" | "folder"; dir: string } | { kind: "rename"; entry: Entry } | null;

interface FilesPanelProps {
  root: string;
  /** Git marks by path relative to the root. */
  marks: Map<string, GitMark>;
  activePath: string | null;
  onOpen: (path: string, pin: boolean) => void;
  onMenu: (e: ReactMouseEvent, entry: Entry | null, actions: { newFile: () => void; newFolder: () => void; rename: () => void }) => void;
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

export function FilesPanel(props: FilesPanelProps) {
  const { root } = props;
  const [children, setChildren] = useState<Map<string, Entry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root]));
  const [editing, setEditing] = useState<Editing>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

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
    void load(root);
  }, [root, load]);

  // Folders whose contents changed on disk are listed again if they are open.
  useEffect(() => {
    const un = listen<string[]>("fs-changed", (event) => {
      for (const dir of event.payload) if (expandedRef.current.has(dir)) void load(dir);
    });
    return () => void un.then((f) => f());
  }, [load]);

  // Reveal the active file: open the folders above it.
  useEffect(() => {
    const path = props.activePath;
    if (!path || !path.startsWith(root + "/")) return;
    setSelected(path);
    const missing: string[] = [];
    for (let dir = dirname(path); dir.length > root.length; dir = dirname(dir)) missing.push(dir);
    if (missing.every((d) => expandedRef.current.has(d))) return;
    setExpanded((s) => new Set([...s, ...missing]));
    for (const dir of missing) if (!children.has(dir)) void load(dir);
  }, [props.activePath]);

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

  const rows: ReactNode[] = [];
  const walk = (dir: string, depth: number, ignoredParent: boolean) => {
    if (editing && editing.kind !== "rename" && editing.dir === dir) {
      rows.push(<div key={`new:${dir}`}>{nameInput(depth, iconUrl(name || "file", editing.kind === "folder"))}</div>);
    }
    for (const entry of children.get(dir) ?? []) {
      const open = entry.dir && expanded.has(entry.path);
      const rel = relative(root, entry.path);
      const mark = entry.dir ? folderMark(props.marks, rel) : props.marks.get(rel) ?? null;
      const ignored = ignoredParent || entry.ignored;
      if (editing?.kind === "rename" && editing.entry.path === entry.path) {
        rows.push(<div key={entry.path}>{nameInput(depth, iconUrl(entry.name, entry.dir, open))}</div>);
      } else {
        rows.push(
          <div
            key={entry.path}
            className={`tree-row${selected === entry.path ? " selected" : ""}${ignored ? " ignored" : ""}${mark ? ` git-${mark.kind}` : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={rel}
            onClick={() => {
              setSelected(entry.path);
              if (entry.dir) toggle(entry);
              else props.onOpen(entry.path, false);
            }}
            onDoubleClick={() => !entry.dir && props.onOpen(entry.path, true)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setSelected(entry.path);
              const dirOfEntry = entry.dir ? entry.path : dirname(entry.path);
              props.onMenu(e, entry, {
                newFile: () => startNew("file", dirOfEntry),
                newFolder: () => startNew("folder", dirOfEntry),
                rename: () => {
                  setName(entry.name);
                  setEditing({ kind: "rename", entry });
                },
              });
            }}
          >
            <span className={`tree-chevron${open ? " open" : ""}`}>{entry.dir && <ChevronRight size={13} />}</span>
            <img className="tree-icon" src={iconUrl(entry.name, entry.dir, open)} alt="" draggable={false} />
            <span className="tree-name">{entry.name}</span>
            {mark && <span className="tree-mark">{mark.letter}</span>}
          </div>,
        );
      }
      if (open) walk(entry.path, depth + 1, ignored);
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
        </div>
      </div>
      <div
        className="tree"
        onContextMenu={(e) => {
          e.preventDefault();
          props.onMenu(e, null, {
            newFile: () => startNew("file", root),
            newFolder: () => startNew("folder", root),
            rename: () => undefined,
          });
        }}
      >
        {rows}
        {children.has(root) && (children.get(root)?.length ?? 0) === 0 && !editing && <div className="panel-empty">This folder is empty.</div>}
      </div>
    </div>
  );
}

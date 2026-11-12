import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getAllWebviewWindows, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ALargeSmall,
  AppWindow,
  AtSign,
  Bell,
  Check,
  ClipboardCopy,
  Copy,
  Cat,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCompare,
  History,
  Keyboard,
  LogIn,
  Moon,
  Option,
  Palette,
  Pencil,
  Plus,
  Rows3,
  ScrollText,
  Split,
  SplitDown,
  MoveOut,
  Claude,
  SquareTerminal,
  Sun,
  TextCursor,
  TextWrap,
  Type,
  BrandMark,
  Trash2,
  X,
} from "./components/icons";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { api, basename, dirname, relative, tildify, toAppError, type AppError, type Entry, type GitFile, type GitStatus, type Notice, type Pick } from "./api";
import { SidebarIcon, type SidebarIconName } from "./components/SidebarIcon";
import { MemeButton } from "./components/Meme";
import { UpdateButton } from "./components/Update";
import { WindowSnap } from "./components/WindowSnap";
import { ContextMenu, type MenuEntry, type MenuState } from "./components/ContextMenu";
import { ChoiceDialog, InputDialog } from "./components/Dialogs";
import { DiffView } from "./components/DiffView";
import { editors, EditorView } from "./components/EditorView";
import { FilesPanel, type GitMark } from "./components/FilesPanel";
import { GitChip } from "./components/GitChip";
import { GitPanel } from "./components/GitPanel";
import { CommandPalette, type Command as PaletteCommand } from "./components/CommandPalette";
import { formatCost, formatTokens, HistoryButton } from "./components/History";
import { PortsButton } from "./components/Ports";
import { noticeFor, NoticePeeks, NotificationBell } from "./components/Notifications";
import { QuickOpen } from "./components/QuickOpen";
import { SearchPanel } from "./components/SearchPanel";
import { TabBar, type DragMode } from "./components/TabBar";
import { ThemePicker } from "./components/ThemePicker";
import { terminals, TerminalView, type TerminalEvent } from "./components/TerminalView";
import {
  availableFonts,
  BLINK_SPEEDS,
  fontCss,
  KEY_REPEAT,
  LINE_HEIGHTS,
  loadSettings,
  saveSetting,
  SCROLLBACK,
  UI_FONTS,
  uiFontCss,
  type Settings,
} from "./lib/settings";
import { newGroupId, newTabId, type ClaudeState, type Reveal, type Tab, type WindowStart } from "./lib/tabs";
import { dividers, halfOf, insertPane, MAX_PANES, paneRects, panesOf, paneTowards, removePane, resizeSplit, sideAt, type Divider, type Layout, type Rect, type Side } from "./lib/layout";
import { applyTheme, COLOR_THEME_KEY, DEFAULT_WINDOW, savedColorTheme, themeVersion, THEMES } from "./lib/themes";
import { isMarkdown } from "./lib/markdown";
import { iconUrl } from "./icons";
import appIcon from "../src-tauri/icons/128x128@2x.png";

const THEME_KEY = "lookout.theme";
/** v2: the default became narrower, so widths saved for the old default are not used. */
const SIDE_KEY = "lookout.sideWidth.v2";
const FONT_KEY = "lookout.fontSize";
const COMPACT_KEY = "lookout.compactBar";
const MEMES_KEY = "lookout.memes";
const SETTINGS_KEY = "lookout.settings";
/** The Claude conversations open in a window, by window label, for reopening them at launch. */
const CLAUDE_TABS_KEY = "lookout.claudeTabs.";
const CURSOR_LABELS = { underline: "Underline", bar: "Bar", block: "Block" } as const;

/** This window. Events are listened to here, so one window does not get another's. */
const appWindow = getCurrentWebviewWindow();

type Theme = "dark" | "light";
type Panel = "files" | "search" | "git";

type DialogState =
  | { type: "choice"; title: string; message: ReactNode; actions: { label: string; kind?: "primary" | "danger-ghost"; onClick: () => void }[] }
  | { type: "input"; title: string; label: string; initial: string; confirm: string; onConfirm: (value: string) => void };

interface Toast {
  id: number;
  kind: "info" | "error";
  message: string;
}

const newId = newTabId;

/** The tabs of the group `g`, in order. */
function tabsIn(list: Tab[], g: string): Tab[] {
  return list.filter((t) => t.group === g);
}

/** The tab in view in the group `g`: the tab in use when it is there, else
 * the one shown there last, else its first. */
function shownIn(list: Tab[], g: string, shown: Record<string, string>, activeId: string | null): Tab | undefined {
  const own = tabsIn(list, g);
  return own.find((t) => t.id === activeId) ?? own.find((t) => t.id === shown[g]) ?? own[0];
}

/** A place in the content as CSS edges, `top` pixels lower for a group with its tabs at its top. */
function rectStyle(r: Rect, top = 0) {
  return {
    left: `${r.x * 100}%`,
    top: top ? `calc(${r.y * 100}% + ${top}px)` : `${r.y * 100}%`,
    right: `${(1 - r.x - r.w) * 100}%`,
    bottom: `${(1 - r.y - r.h) * 100}%`,
  };
}

/** Where a tab dragged out of its bar goes: a new window, in among another
 * group's tabs, into a group, or a new group on one side of a group. */
type DropTarget =
  | { kind: "out" }
  | { kind: "strip"; group: string; index: number }
  | { kind: "move"; group: string; rect: Rect }
  | { kind: "split"; group: string; side: Side; rect: Rect }
  | { kind: "full"; group: string; rect: Rect };

/** The height of the tabs at the top of a group below the title bar. */
const GROUP_TABS = 34;

/** A group starts at the top of the window, so its tabs are in the title bar. */
const atTop = (r: Rect) => r.y < 1e-6;

/** A pane is not made narrower or lower than this by dragging a line. */
const MIN_PANE = { row: 160, column: 90 };

/** A tab that runs `claude --resume` for a past conversation. */
function resumeTab(id: string, cwd: string | null, title: string | null): Tab {
  return {
    kind: "terminal",
    id: newId(),
    cwd,
    run: `claude --resume ${id}`,
    sessionId: null,
    title: title ?? "claude",
    claude: false,
    sessionName: title ?? undefined,
    claudeSession: id,
    claudeCwd: cwd ?? undefined,
  };
}

function markFor(file: GitFile): GitMark {
  if (file.index === "U") return { letter: "!", kind: "conflict" };
  if (file.work === "?") return { letter: "U", kind: "untracked" };
  const letter = file.work !== "." ? file.work : file.index;
  if (letter === "D") return { letter: "D", kind: "deleted" };
  if (letter === "A") return { letter: "A", kind: "added" };
  if (letter === "R") return { letter: "R", kind: "renamed" };
  return { letter: "M", kind: "modified" };
}

/** A Claude tab's title: the session's name, or else the topic Claude Code
 * puts in the terminal title without its status glyph, or "claude" before either. */
function claudeTitle(tab: { termTitle?: string; sessionName?: string }): string {
  if (tab.sessionName) return tab.sessionName;
  const topic = (tab.termTitle ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return topic && topic !== "Claude Code" ? topic : "claude";
}

export default function App() {
  const [folder, setFolder] = useState<string | null>(null);
  const [home, setHome] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [started, setStarted] = useState(false);
  // The side panel opens from the icons on the left and is closed at start.
  const [panel, setPanel] = useState<Panel | null>(null);
  const [sideWidth, setSideWidth] = useState(() => Number(localStorage.getItem(SIDE_KEY)) || 240);
  /** The panel that just closed, kept on screen while the side panel narrows away. */
  const [closingPanel, setClosingPanel] = useState<Panel | null>(null);
  const shownPanelRef = useRef<Panel | null>(null);
  useEffect(() => {
    if (panel) {
      shownPanelRef.current = panel;
      setClosingPanel(null);
      return;
    }
    setClosingPanel(shownPanelRef.current);
    const timer = setTimeout(() => setClosingPanel(null), 320);
    return () => clearTimeout(timer);
  }, [panel]);
  const sidePanel = panel ?? closingPanel;
  /** The left icon bar minimized to small icons. */
  const [compact, setCompact] = useState(() => localStorage.getItem(COMPACT_KEY) === "1");
  /** The meme button in the corner. */
  const [memes, setMemes] = useState(() => localStorage.getItem(MEMES_KEY) !== "0");
  const [settings, setSettings] = useState(loadSettings);
  const changeSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    saveSetting(key, value);
  };
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem(FONT_KEY)) || 13);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === "light" ? "light" : "dark"));
  /** The color theme: an id from THEMES. `theme` is light or dark mode. */
  const [colorTheme, setColorTheme] = useState(savedColorTheme);
  /** Set on the first click, so the switch's stretch animation does not play at startup. */
  const [themeSwitched, setThemeSwitched] = useState(false);
  const [git, setGit] = useState<GitStatus | null | undefined>(undefined);
  const [gitBusy, setGitBusy] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [searchToken, setSearchToken] = useState(0);
  const [quickFiles, setQuickFiles] = useState<string[] | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  /** Picks waiting for a Claude session that is still starting, by tab. */
  const waiting = useRef(new Map<string, Pick[]>());
  /** All windows' notifications, newest first. */
  const [notices, setNotices] = useState<Notice[]>([]);
  /** Notifications popping up under the bell in this window. */
  const [peeks, setPeeks] = useState<Notice[]>([]);
  /** Bumped by ⌘Y to open the history panel. */
  const [historySignal, setHistorySignal] = useState(0);
  const [palette, setPalette] = useState(false);
  /** How the window is split into groups, each with its own tabs, by group id. */
  const [layout, setLayout] = useState<Layout>(() => ({ pane: newGroupId() }));
  /** The tab shown last in each group, by group id. The group in use shows activeId. */
  const [groupShown, setGroupShown] = useState<Record<string, string>>({});
  /** Where the tab being dragged goes when let go. */
  const [drop, setDrop] = useState<DropTarget | null>(null);
  /** The same, set as the pointer moves, before the next render. */
  const dropRef = useRef<DropTarget | null>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  const titleTabsRef = useRef<HTMLDivElement>(null);
  /** Each group's tab bar, by group id, to drop tabs on. */
  const bars = useRef(new Map<string, HTMLDivElement>());
  /** "Copied" or "Pasted" over the meme button for a moment, after a copy or paste in a terminal. */
  const [clipNote, setClipNote] = useState<{ text: string; key: number; leaving: boolean } | null>(null);
  const clipTimer = useRef(0);
  const noteClipboard = useCallback((kind: "copied" | "pasted") => {
    const text = kind === "copied" ? "Copied" : "Pasted";
    window.clearTimeout(clipTimer.current);
    // The same note again stays up; it fades out a moment after the last one.
    setClipNote((note) => (note && note.text === text && !note.leaving ? note : { text, key: Date.now(), leaving: false }));
    clipTimer.current = window.setTimeout(() => {
      setClipNote((note) => note && { ...note, leaving: true });
      clipTimer.current = window.setTimeout(() => setClipNote(null), 250);
    }, 1200);
  }, []);

  const latest = useRef({ tabs, activeId, folder, git, panel, settings, layout, groupShown });
  latest.current = { tabs, activeId, folder, git, panel, settings, layout, groupShown };
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const groups = panesOf(layout);
  const rects = paneRects(layout);
  /** The tab in view in each group. */
  const visible = groups.flatMap((g) => shownIn(tabs, g, groupShown, activeId) ?? []);
  const visibleKey = visible.map((t) => t.id).join(" ");

  // The group in use remembers its tab, for when another group has the keyboard.
  useEffect(() => {
    const tab = tabs.find((t) => t.id === activeId);
    if (tab?.group && groupShown[tab.group] !== tab.id) setGroupShown((m) => ({ ...m, [tab.group!]: tab.id }));
  }, [activeId, tabs, groupShown]);

  // The title bar's tabs sit above their groups: it gets where the content starts and how wide it is.
  useLayoutEffect(() => {
    const bar = titleTabsRef.current;
    const content = panesRef.current;
    if (!bar || !content) return;
    const update = () => {
      const b = bar.getBoundingClientRect();
      const c = content.getBoundingClientRect();
      bar.style.setProperty("--cl", `${c.left - b.left}px`);
      bar.style.setProperty("--cw", `${c.width}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // Every tab is in a group of the layout, and a group whose last tab left closes.
  useLayoutEffect(() => {
    const ids = panesOf(layout);
    if (tabs.some((t) => !t.group || !ids.includes(t.group))) {
      const home = tabs.find((t) => t.id === activeId)?.group;
      const g = home && ids.includes(home) ? home : ids[0];
      setTabs((l) => l.map((t) => (!t.group || !ids.includes(t.group) ? { ...t, group: g } : t)));
      return;
    }
    const empty = ids.filter((g) => !tabs.some((t) => t.group === g));
    if (!empty.length || ids.length < 2) return;
    setLayout((l) => {
      let next = l;
      for (const g of empty) if (panesOf(next).length > 1) next = removePane(next, g) ?? next;
      return next;
    });
  }, [tabs, layout, activeId]);

  const toast = useCallback((kind: Toast["kind"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 2500);
  }, []);

  // ---- Theme ----

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    void getCurrentWindow().setTheme(theme).catch(() => undefined);
  }, [theme]);

  useEffect(() => document.documentElement.style.setProperty("--code-font", fontCss(settings.font)), [settings.font]);

  useEffect(() => document.documentElement.style.setProperty("--font", uiFontCss(settings.uiFont)), [settings.uiFont]);

  // Settings changed in another window apply here too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SETTINGS_KEY) setSettings(loadSettings());
      else if (e.key === THEME_KEY && (e.newValue === "dark" || e.newValue === "light")) setTheme(e.newValue);
      else if (e.key === COLOR_THEME_KEY && e.newValue) setColorTheme(e.newValue);
      else if (e.key === FONT_KEY && Number(e.newValue)) setFontSize(Number(e.newValue));
      else if (e.key === MEMES_KEY) setMemes(e.newValue !== "0");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => void api.pickerSetEnabled(settings.picker).catch(() => undefined), [settings.picker]);

  // Read by the patched xterm WebGL renderer (patches/@xterm__addon-webgl.patch).
  useEffect(() => void ((globalThis as { __lookoutBlinkMs?: number }).__lookoutBlinkMs = settings.blinkMs), [settings.blinkMs]);

  // The theme's colors are CSS variables; set on the root they override styles.css.
  useEffect(() => applyTheme(colorTheme, theme), [colorTheme, theme]);
  const pickTheme = (id: string) => {
    setColorTheme(id);
    localStorage.setItem(COLOR_THEME_KEY, id);
  };

  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontSize));
    document.documentElement.style.setProperty("--editor-font-size", `${fontSize}px`);
  }, [fontSize]);

  // ---- Tabs ----

  /** The group new tabs go to: the one with the tab in use. */
  const currentGroup = useCallback(() => {
    const { tabs: list, activeId: current, layout: lay } = latest.current;
    const g = list.find((t) => t.id === current)?.group;
    return g && panesOf(lay).includes(g) ? g : panesOf(lay)[0];
  }, []);

  /** Opens a tab in the group `into`, or the group in use, after the tab shown there. */
  const addTab = useCallback(
    (tab: Tab, into?: string) => {
      const g = into ?? currentGroup();
      const placed: Tab = { ...tab, group: g };
      setTabs((list) => {
        const shown = shownIn(list, g, latest.current.groupShown, latest.current.activeId);
        const at = shown ? list.indexOf(shown) + 1 : list.map((t) => t.group).lastIndexOf(g) + 1 || list.length;
        const next = [...list];
        next.splice(at, 0, placed);
        return next;
      });
      setActiveId(placed.id);
    },
    [currentGroup],
  );

  const newTerminal = useCallback(
    (claude: boolean, cwd?: string, into?: string) => {
      addTab(
        {
          kind: "terminal",
          id: newId(),
          cwd: cwd ?? latest.current.folder,
          run: claude ? "claude" : null,
          sessionId: null,
          title: claude ? "claude" : "zsh",
          claude,
        },
        into,
      );
    },
    [addTab],
  );

  /** Takes a tab out. Its group shows the tab beside it; a group whose last tab
   * this was closes, and the group before it gets the keyboard. */
  const removeTab = useCallback((id: string) => {
    const { tabs: list, activeId: current, layout: lay, groupShown: shown } = latest.current;
    const tab = list.find((t) => t.id === id);
    if (!tab) return;
    const g = tab.group ?? "";
    const own = tabsIn(list, g);
    const index = own.findIndex((t) => t.id === id);
    const rest = own.filter((t) => t.id !== id);
    const next = rest[Math.min(index, rest.length - 1)];
    setTabs((l) => l.filter((t) => t.id !== id));
    if (next && shownIn(list, g, shown, current)?.id === id) setGroupShown((m) => ({ ...m, [g]: next.id }));
    if (current !== id) return;
    if (next) return setActiveId(next.id);
    const order = panesOf(lay);
    const other = order[order.indexOf(g) - 1] ?? order[order.indexOf(g) + 1];
    setActiveId(other ? (shownIn(list, other, shown, null)?.id ?? null) : null);
  }, []);

  const closeTab = useCallback((id: string, force = false) => {
    const tab = latest.current.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (!force && tab.kind === "file" && tab.dirty) {
      setDialog({
        type: "choice",
        title: `Save changes to ${basename(tab.path)}?`,
        message: "Your changes are lost if you don't save them.",
        actions: [
          { label: "Don't Save", kind: "danger-ghost", onClick: () => (setDialog(null), closeTab(id, true)) },
          {
            label: "Save",
            kind: "primary",
            onClick: async () => {
              setDialog(null);
              if (await editors.get(id)?.save()) closeTab(id, true);
            },
          },
        ],
      });
      return;
    }
    removeTab(id);
  }, []);

  /** The tab in view in each group. */
  const visibleTabs = useCallback(() => {
    const { tabs: list, layout: lay, groupShown: shown, activeId: current } = latest.current;
    return panesOf(lay).flatMap((g) => shownIn(list, g, shown, current) ?? []);
  }, []);

  /** Shows a tab in its group, which gets the keyboard. */
  const showTab = useCallback((tabId: string) => {
    if (latest.current.tabs.some((t) => t.id === tabId)) setActiveId(tabId);
  }, []);

  /** Opens a terminal in a new group on the `side` of the group `from` (or the
   * group in use), in the folder of the terminal shown there. */
  const splitTerminal = useCallback(
    async (side: Side = "right", from?: string) => {
      const { tabs: list, activeId: current, layout: lay, groupShown: shown } = latest.current;
      if (panesOf(lay).length >= MAX_PANES) return toast("info", `A window splits into ${MAX_PANES} at most`);
      const g = from ?? currentGroup();
      const here = shownIn(list, g, shown, current);
      const info = here?.kind === "terminal" && here.sessionId ? await api.ptyInfo(here.sessionId).catch(() => null) : null;
      const cwd = info?.cwd ?? (here?.kind === "terminal" ? here.cwd : null) ?? latest.current.folder;
      const group = newGroupId();
      setLayout((l) => insertPane(l, g, side, { pane: group }));
      addTab({ kind: "terminal", id: newId(), cwd, run: null, sessionId: null, title: "zsh", claude: false }, group);
    },
    [toast, currentGroup, addTab],
  );

  /** Moves a tab into the group `g`: before its tab at `index` among the
   * others, or else after the tab shown there. The group it leaves shows the
   * tab beside it. */
  const moveToGroup = useCallback((id: string, g: string, index?: number) => {
    const { tabs: list } = latest.current;
    const tab = list.find((t) => t.id === id);
    if (!tab) return;
    const from = tab.group ?? "";
    if (from !== g) {
      const own = tabsIn(list, from);
      const i = own.findIndex((t) => t.id === id);
      const rest = own.filter((t) => t.id !== id);
      const next = rest[Math.min(i, rest.length - 1)];
      if (next) setGroupShown((m) => ({ ...m, [from]: next.id }));
    }
    setTabs((l) => {
      const moving = l.find((t) => t.id === id);
      if (!moving) return l;
      const rest = l.filter((t) => t.id !== id);
      const own = rest.filter((t) => t.group === g);
      let at: number;
      if (index !== undefined) at = index < own.length ? rest.indexOf(own[index]) : own.length ? rest.indexOf(own[own.length - 1]) + 1 : rest.length;
      else {
        const after = shownIn(rest, g, latest.current.groupShown, null);
        at = after ? rest.indexOf(after) + 1 : rest.length;
      }
      rest.splice(at, 0, { ...moving, group: g });
      return rest;
    });
    setActiveId(id);
  }, []);

  /** Moves a tab into a new group on the `side` of the group `target`. */
  const splitWith = useCallback(
    (id: string, target: string, side: Side) => {
      if (panesOf(latest.current.layout).length >= MAX_PANES) return;
      const group = newGroupId();
      setLayout((l) => insertPane(l, target, side, { pane: group }));
      moveToGroup(id, group);
    },
    [moveToGroup],
  );

  const openFile = useCallback(
    (path: string, pin: boolean, reveal: Reveal | null = null) => {
      const list = latest.current.tabs;
      const existing = list.find((t) => t.kind === "file" && t.path === path);
      if (existing) {
        setTabs((l) => l.map((t) => (t.id === existing.id && t.kind === "file" ? { ...t, preview: t.preview && !pin, reveal: reveal ?? t.reveal } : t)));
        setActiveId(existing.id);
        if (reveal) editors.get(existing.id)?.goTo(reveal.line, reveal.from, reveal.to);
        return;
      }
      const tab: Tab = { kind: "file", id: newId(), path, dirty: false, preview: !pin, reveal };
      // A single click replaces the group's preview tab, as in VS Code.
      const g = currentGroup();
      const preview = list.find((t) => t.kind === "file" && t.preview && !t.dirty && t.group === g);
      if (!pin && preview) {
        setTabs((l) => l.map((t) => (t.id === preview.id ? { ...tab, group: preview.group } : t)));
        setActiveId(tab.id);
        return;
      }
      addTab(tab);
    },
    [addTab, currentGroup],
  );

  const openDiff = useCallback(
    (root: string, path: string, staged: boolean) => {
      const existing = latest.current.tabs.find((t) => t.kind === "diff" && t.root === root && t.path === path && t.staged === staged);
      if (existing) return setActiveId(existing.id);
      addTab({ kind: "diff", id: newId(), root, path, staged });
    },
    [addTab],
  );

  useEffect(() => {
    const unPick = appWindow.listen<Pick>("picked", (event) => {
      setPicks((list) => [...list.slice(-7), event.payload]);
      sendPickRef.current(event.payload);
    });
    const unErr = appWindow.listen<AppError>("picker-error", (event) => {
      if (event.payload.code !== "permission") return toast("error", event.payload.message);
      setDialog({
        type: "choice",
        title: "Allow Accessibility access",
        message: event.payload.message,
        actions: [
          {
            label: "Open Settings",
            kind: "primary",
            onClick: () => {
              setDialog(null);
              void api.openAccessibilitySettings();
            },
          },
        ],
      });
    });
    const unStart = appWindow.listen("picker-started", () => toast("info", "Point at anything and click to pick it. Esc cancels."));
    return () => {
      void unPick.then((f) => f());
      void unErr.then((f) => f());
      void unStart.then((f) => f());
    };
  }, [toast]);

  // A terminal's shell exiting closes its tab.
  useEffect(() => {
    const un = appWindow.listen<string>("pty-exit", (event) => {
      const tab = latest.current.tabs.find((t) => t.kind === "terminal" && t.sessionId === event.payload);
      if (tab) removeTab(tab.id);
    });
    return () => void un.then((f) => f());
  }, [removeTab]);

  // ---- Notifications ----

  useEffect(() => {
    void api.notices().then(setNotices);
    const unList = appWindow.listen<Notice[]>("notices", (event) => setNotices(event.payload));
    const unPeek = appWindow.listen<Notice>("notice-peek", (event) => setPeeks((list) => [...list.slice(-2), event.payload]));
    // A notification was clicked in some window; the window with the tab shows it.
    const unOpen = appWindow.listen<string>("activate-tab", (event) => {
      if (!latest.current.tabs.some((t) => t.id === event.payload)) return;
      showTab(event.payload);
      void appWindow.unminimize().then(() => appWindow.setFocus());
    });
    return () => {
      void unList.then((f) => f());
      void unPeek.then((f) => f());
      void unOpen.then((f) => f());
    };
  }, [showTab]);

  const terminalEvent = async (tabId: string, event: TerminalEvent) => {
    const tab = latest.current.tabs.find((t) => t.id === tabId);
    if (tab?.kind !== "terminal") return;
    if (event.type === "title") {
      const termTitle = event.title;
      setTabs((l) =>
        l.map((t) => (t.id === tabId && t.kind === "terminal" ? { ...t, termTitle, title: t.claude ? claudeTitle({ ...t, termTitle }) : t.title } : t)),
      );
      return;
    }
    if (event.type === "claude") {
      const hook = event.hook;
      const name = hook.hook_event_name;
      // null leaves the dot as it is.
      let state: ClaudeState | undefined | null = null;
      if (name === "UserPromptSubmit" || name === "PostToolUse") state = "working";
      else if (name === "Stop" && !hook.stop_hook_active) state = "done";
      else if (name === "Notification" && hook.notification_type !== "idle_prompt" && !/waiting for your input/i.test(hook.message ?? "")) state = "waiting";
      else if (name === "SessionStart") state = undefined;
      const inView = visibleTabs().some((t) => t.id === tabId);
      setTabs((l) =>
        l.map((t) =>
          t.id === tabId && t.kind === "terminal"
            ? {
                ...t,
                claudeSession: hook.session_id ?? t.claudeSession,
                claudeCwd: hook.cwd ?? t.claudeCwd,
                // A tab in view needs no dot to say Claude is done.
                claudeState: state === null ? t.claudeState : inView && state !== "working" ? undefined : state,
              }
            : t,
        ),
      );
      // The transcript has the session's name, and when Claude stops, its usage so far.
      const transcript = hook.transcript_path;
      if (transcript && (name === "SessionStart" || name === "Stop" || name === "Notification")) {
        void api.claudeTitle(transcript).then((sessionName) => {
          if (!sessionName) return;
          setTabs((l) =>
            l.map((t) => (t.id === tabId && t.kind === "terminal" ? { ...t, sessionName, title: t.claude ? sessionName : t.title } : t)),
          );
        });
      }
      if (transcript && name === "Stop") {
        void api.claudeSessionDetails(transcript).then((d) => {
          if (!d) return;
          setTabs((l) => l.map((t) => (t.id === tabId && t.kind === "terminal" ? { ...t, usage: { tokens: d.tokens, cost: d.cost } } : t)));
        });
      }
    }
    // Claude's own messages repeat what its hooks report.
    if (event.type === "message" && tab.claude) return;
    const tabTitle = event.type === "claude" && event.hook.cwd ? basename(event.hook.cwd) : tab.title;
    const notice = await noticeFor(event, tabTitle);
    if (!notice) return;
    void api.noticePost({ ...notice, tabId, tabTitle, tabActive: latest.current.activeId === tabId, banner: latest.current.settings.banners });
  };

  // Terminal tab titles follow the program in front (zsh, claude, npm) and the folder.
  useEffect(() => {
    const timer = setInterval(async () => {
      for (const tab of latest.current.tabs) {
        if (tab.kind !== "terminal" || !tab.sessionId) continue;
        const info = await api.ptyInfo(tab.sessionId).catch(() => null);
        if (!info) continue;
        const program = info.process ?? "";
        const claude = program === "claude";
        const shell = ["zsh", "bash", "fish", "sh", "-zsh", "login"].includes(program);
        const title = claude ? claudeTitle(tab) : shell ? (info.cwd ? basename(info.cwd) : program) : program;
        if (title && (title !== tab.title || claude !== tab.claude)) {
          // A Claude that quit takes its session name and topic with it.
          const names = claude ? {} : { sessionName: undefined, termTitle: undefined, claudeSession: undefined, claudeState: undefined, usage: undefined };
          setTabs((l) => l.map((t) => (t.id === tab.id && t.kind === "terminal" ? { ...t, title, claude, ...names } : t)));
        }
        const queued = waiting.current.get(tab.id);
        if (claude && queued) {
          waiting.current.delete(tab.id);
          // Claude Code needs a moment after starting before it takes input.
          setTimeout(() => queued.forEach((p) => pasteSequenceRef.current(tab.id, p)), 1200);
        }
      }
    }, 1500);
    return () => clearInterval(timer);
  }, []);

  // ---- Folder ----

  const openFolder = useCallback(
    async (path: string, terminal = true) => {
      const before = latest.current.folder;
      setFolder(path);
      setGit(undefined);
      setQuickFiles(null);
      setRecent(await api.addRecentFolder(path));
      void api.watchFolder(path).catch((e) => toast("error", toAppError(e).message));
      void getCurrentWindow().setTitle(`Lookout - ${basename(path)}`);
      // Another folder: terminals that wait at the prompt with nothing typed move to it.
      if (before && before !== path) for (const tab of latest.current.tabs) if (tab.kind === "terminal") terminals.get(tab.id)?.cd(path);
      if (terminal && !latest.current.tabs.some((t) => t.kind === "terminal")) newTerminal(false, path);
    },
    [newTerminal, toast],
  );

  const chooseFolder = useCallback(async () => {
    const path = await openDialog({ directory: true, multiple: false });
    if (typeof path === "string") void openFolder(path);
  }, [openFolder]);

  /** Resumes the Claude conversations that were open in any window when Lookout quit. */
  const restoreClaudeTabs = () => {
    const keys: string[] = [];
    const seen = new Set<string>();
    const restore: { id: string; cwd: string | null; title: string | null }[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(CLAUDE_TABS_KEY)) keys.push(key);
      }
      for (const key of keys) {
        const list = JSON.parse(localStorage.getItem(key) ?? "[]") as typeof restore;
        for (const entry of list) {
          if (typeof entry?.id !== "string" || !/^[0-9a-f-]+$/i.test(entry.id) || seen.has(entry.id)) continue;
          seen.add(entry.id);
          restore.push(entry);
        }
      }
      for (const key of keys) localStorage.removeItem(key);
    } catch {
      return;
    }
    if (!latest.current.settings.restoreClaude) return;
    for (const entry of restore) addTab(resumeTab(entry.id, entry.cwd, entry.title));
  };

  // The Claude conversations open here, for reopening them at the next launch.
  useEffect(() => {
    if (!started) return;
    const open = tabs.flatMap((t) =>
      t.kind === "terminal" && t.claude && t.claudeSession ? [{ id: t.claudeSession, cwd: t.claudeCwd ?? t.cwd, title: t.sessionName ?? null }] : [],
    );
    try {
      localStorage.setItem(CLAUDE_TABS_KEY + appWindow.label, JSON.stringify(open));
    } catch {
      // Only for reopening; nothing else depends on it.
    }
  }, [tabs, started]);

  // Done and waiting dots clear once the tab is in view in its group.
  useEffect(() => {
    const ids = new Set(visibleKey.split(" "));
    const seen = (t: Tab) => t.kind === "terminal" && ids.has(t.id) && (t.claudeState === "done" || t.claudeState === "waiting");
    setTabs((l) => (l.some(seen) ? l.map((t) => (seen(t) && t.kind === "terminal" ? { ...t, claudeState: undefined } : t)) : l));
  }, [visibleKey]);

  // React runs effects twice in development; the folder must open once.
  const startup = useRef(false);
  useEffect(() => {
    if (startup.current) return;
    startup.current = true;
    void (async () => {
      setHome(await api.homeDir());
      const list = await api.recentFolders();
      setRecent(list);
      const start = (await api.windowStart().catch(() => null)) as WindowStart | null;
      if (start) {
        // A window opened with ⌘N or by dragging a tab out: the other window's folder, and the tab.
        if (start.folder) await openFolder(start.folder, !start.tab);
        else if (!start.tab) newTerminal(false);
        if (start.tab) addTab(start.tab);
      } else if (list[0]) {
        // Start with a terminal: in the last project, or in the home folder.
        await openFolder(list[0]);
      } else {
        newTerminal(false);
      }
      // A fresh launch, not a window opened from another one: reopen the Claude conversations.
      if (!start) restoreClaudeTabs();
      setStarted(true);
    })();
  }, []);

  // ---- Git ----

  const refreshGit = useCallback(async () => {
    const root = latest.current.folder;
    if (!root) return;
    try {
      setGit(await api.gitStatus(root));
    } catch (e) {
      setGit(null);
    }
  }, []);

  useEffect(() => {
    void refreshGit();
  }, [folder, refreshGit]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const un = appWindow.listen("git-changed", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void refreshGit();
        setDataVersion((v) => v + 1);
      }, 300);
    });
    const unFs = appWindow.listen<string[]>("fs-changed", (event) => {
      setQuickFiles(null);
      // Open files that changed on disk and have no unsaved edits are read again.
      for (const tab of latest.current.tabs) {
        if (tab.kind === "file" && event.payload.includes(dirname(tab.path))) editors.get(tab.id)?.reload();
      }
    });
    const onFocus = () => void refreshGit();
    window.addEventListener("focus", onFocus);
    return () => {
      void un.then((f) => f());
      void unFs.then((f) => f());
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshGit]);

  const gitAction = async (label: string, run: () => Promise<unknown>, done?: string) => {
    setGitBusy(label);
    try {
      await run();
      if (done) toast("info", done);
      return true;
    } catch (e) {
      toast("error", toAppError(e).message);
      return false;
    } finally {
      setGitBusy(null);
      void refreshGit();
    }
  };

  const marks = useMemo(() => {
    const map = new Map<string, GitMark>();
    if (!git || !folder) return map;
    for (const file of git.files) {
      const full = `${git.root}/${file.path}`;
      if (full.startsWith(folder + "/")) map.set(relative(folder, full), markFor(file));
    }
    return map;
  }, [git, folder]);

  const commit = async (message: string, amend: boolean): Promise<boolean> => {
    const status = latest.current.git;
    if (!status) return false;
    const staged = status.files.some((f) => f.index !== "." && f.index !== "?");
    if (!staged) {
      return new Promise((resolve) =>
        setDialog({
          type: "choice",
          title: "Stage all changes and commit?",
          message: "Nothing is staged. Lookout can stage every change and commit it.",
          actions: [
            {
              label: "Stage All and Commit",
              kind: "primary",
              onClick: async () => {
                setDialog(null);
                resolve(
                  await gitAction("Committing", async () => {
                    await api.gitStage(status.root, ["."]);
                    await api.gitCommit(status.root, message, amend);
                  }, "Committed"),
                );
              },
            },
          ],
        }),
      );
    }
    return gitAction("Committing", () => api.gitCommit(status.root, message, amend), "Committed");
  };

  const discard = (files: GitFile[]) => {
    const status = latest.current.git;
    if (!status) return;
    const untracked = files.filter((f) => f.work === "?").map((f) => f.path);
    const tracked = files.filter((f) => f.work !== "?").map((f) => f.path);
    setDialog({
      type: "choice",
      title: files.length === 1 ? `Discard changes in ${basename(files[0].path)}?` : `Discard changes in ${files.length} files?`,
      message: untracked.length
        ? "Changes in tracked files are lost. New files go to the Trash."
        : "The changes are lost. This cannot be undone.",
      actions: [
        {
          label: "Discard",
          kind: "primary",
          onClick: () => {
            setDialog(null);
            void gitAction("Discarding", () => api.gitDiscard(status.root, tracked, untracked));
          },
        },
      ],
    });
  };

  const sync = () => {
    const status = latest.current.git;
    if (!status) return;
    if (!status.upstream) {
      void gitAction("Publishing", () => api.gitPush(status.root), `Published ${status.branch}`);
      return;
    }
    void gitAction(
      "Syncing",
      async () => {
        if (status.behind > 0) await api.gitPull(status.root);
        if (status.ahead > 0 || status.behind === 0) await api.gitPush(status.root);
      },
      "Synced",
    );
  };

  const branchMenu = async (e: ReactMouseEvent) => {
    const status = latest.current.git;
    if (!status) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const branches = await api.gitBranches(status.root).catch(() => null);
    if (!branches) return;
    const locals = new Set(branches.local);
    const items: MenuEntry[] = [
      {
        label: "Create Branch…",
        icon: <Plus size={14} />,
        onSelect: () =>
          setDialog({
            type: "input",
            title: "Create branch",
            label: "Branch name",
            initial: "",
            confirm: "Create",
            onConfirm: (name) => {
              setDialog(null);
              if (name.trim()) void gitAction("Switching", () => api.gitSwitch(status.root, name.trim(), true), `On ${name.trim()}`);
            },
          }),
      },
      { label: "Fetch", icon: <GitCompare size={14} />, onSelect: () => void gitAction("Fetching", () => api.gitFetch(status.root), "Fetched") },
      "separator",
      ...branches.local.map((b) => ({
        label: b,
        icon: <GitBranch size={14} />,
        checked: b === branches.current,
        onSelect: () => void gitAction("Switching", () => api.gitSwitch(status.root, b, false), `On ${b}`),
      })),
      ...branches.remote
        .filter((r) => !locals.has(r.slice(r.indexOf("/") + 1)))
        .map((r) => ({
          label: r,
          icon: <GitBranch size={14} />,
          onSelect: () => void gitAction("Switching", () => api.gitSwitch(status.root, r.slice(r.indexOf("/") + 1), false), `On ${r}`),
        })),
    ];
    setMenu({ x: rect.left, y: rect.bottom + 4, items });
  };

  // ---- Claude helpers ----

  /** The terminal to send to: the one in use, or one in view in another group, or a Claude terminal. */
  const targetTerminal = () => {
    const list = latest.current.tabs;
    const here = list.find((t) => t.id === latest.current.activeId);
    if (here?.kind === "terminal") return here;
    return (
      visibleTabs().find((t) => t.kind === "terminal") ?? list.find((t) => t.kind === "terminal" && t.claude) ?? list.find((t) => t.kind === "terminal") ?? null
    );
  };

  /** Pastes a pick into a Claude terminal: the screenshot path first (Claude
   * Code attaches it as [Image #n]), then the description as one paste. */
  const pasteSequence = (tabId: string, pick: Pick) => {
    const terminal = terminals.get(tabId);
    if (!terminal) return;
    if (pick.image) terminal.paste(pick.image + " ");
    const at = pick.image ? 250 : 0;
    setTimeout(() => terminal.paste(pick.report), at);
    // Typed, not pasted, so Claude puts it after the [Pasted text] marker and the cursor is ready for typing.
    setTimeout(() => terminal.send(" "), at + 150);
    showTab(tabId);
    setTimeout(() => terminal.focus(), at + 200);
  };

  const sendPick = (pick: Pick) => {
    const { tabs: list, activeId: current } = latest.current;
    const here = list.find((t) => t.id === current);
    // The tab in use when it runs Claude, or else a Claude tab in view in another group, or any Claude tab.
    const claudeTab =
      (here?.kind === "terminal" && here.claude ? here : undefined) ??
      visibleTabs().find((t) => t.kind === "terminal" && t.claude) ??
      list.find((t) => t.kind === "terminal" && t.claude);
    if (claudeTab) return pasteSequence(claudeTab.id, pick);
    // No Claude session yet: start one and paste once Claude is running.
    const id = newId();
    waiting.current.set(id, [pick]);
    addTab({ kind: "terminal", id, cwd: latest.current.folder, run: "claude", sessionId: null, title: "claude", claude: false });
  };

  const mentionInClaude = (paths: string[]) => {
    const tab = targetTerminal();
    const root = latest.current.folder;
    if (!tab) return toast("error", "Open a terminal first");
    terminals.get(tab.id)?.paste(paths.map((path) => `@${root ? relative(root, path) : path} `).join(""));
    showTab(tab.id);
    terminals.get(tab.id)?.focus();
  };

  /** Asks, then moves files and folders to the Trash and closes their tabs. */
  const trashEntries = (entries: Entry[]) => {
    if (!entries.length) return;
    const one = entries.length === 1 ? entries[0] : null;
    setDialog({
      type: "choice",
      title: one ? `Move ${one.name} to the Trash?` : `Move ${entries.length} items to the Trash?`,
      message: entries.some((e) => e.dir) ? "Folders go to the Trash with everything in them." : "You can put them back from the Trash.",
      actions: [
        {
          label: "Move to Trash",
          kind: "primary",
          onClick: () => {
            setDialog(null);
            const paths = entries.map((e) => e.path);
            api.trashPaths(paths).then(
              () => {
                for (const t of latest.current.tabs) {
                  if (t.kind === "file" && paths.some((p) => t.path === p || t.path.startsWith(p + "/"))) closeTab(t.id, true);
                }
              },
              (err) => toast("error", toAppError(err).message),
            );
          },
        },
      ],
    });
  };

  /** Open files follow files and folders moved in the Files panel. */
  const filesMoved = (moves: [string, string][]) =>
    setTabs((l) =>
      l.map((t) => {
        if (t.kind !== "file") return t;
        for (const [from, to] of moves) {
          if (t.path === from || t.path.startsWith(from + "/")) return { ...t, path: to + t.path.slice(from.length) };
        }
        return t;
      }),
    );

  // Files dropped on a terminal are typed into it as paths, as in Terminal.
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((event) => {
      const drop = event.payload;
      if (drop.type !== "drop" || !drop.paths.length) return;
      const el = document.elementFromPoint(drop.position.x / window.devicePixelRatio, drop.position.y / window.devicePixelRatio);
      // The pane under the drop, in a split tab.
      const id = el?.closest<HTMLElement>(".terminal-view")?.dataset.tab;
      if (!id) return;
      const quoted = drop.paths.map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`));
      terminals.get(id)?.paste(quoted.join(" ") + " ");
      terminals.get(id)?.focus();
    });
    return () => void un.then((f) => f());
  }, []);

  const sendPickRef = useRef(sendPick);
  sendPickRef.current = sendPick;
  const pasteSequenceRef = useRef(pasteSequence);
  pasteSequenceRef.current = pasteSequence;

  // ---- Windows ----

  /** A new window on the same folder, with a fresh terminal. */
  const newWindow = useCallback(() => {
    const start: WindowStart = { folder: latest.current.folder, tab: null };
    void api.windowNew({ start, session: null, x: null, y: null }).catch((e) => toast("error", toAppError(e).message));
  }, [toast]);

  // New Window in the Dock menu goes to the window used last.
  useEffect(() => {
    const un = appWindow.listen("new-window", newWindow);
    return () => void un.then((f) => f());
  }, [newWindow]);

  /** Moves a tab to its own window, at the drop point when dragged there. A
   * terminal keeps its shell and what is on screen. */
  const moveToNewWindow = async (id: string, at?: { x: number; y: number }) => {
    const { tabs: list, folder: current } = latest.current;
    const tab = list.find((t) => t.id === id);
    if (!tab || list.length < 2) return;
    let moving: Tab = tab;
    let session: string | null = null;
    const terminal = tab.kind === "terminal" ? terminals.get(tab.id) : undefined;
    try {
      if (tab.kind === "terminal") {
        if (!terminal || !tab.sessionId) return;
        session = tab.sessionId;
        moving = { ...tab, group: undefined, snapshot: await terminal.moveOut() };
      } else if (tab.kind === "file") {
        const editor = editors.get(tab.id);
        moving = { ...tab, group: undefined, preview: false, text: tab.dirty ? editor?.text() : undefined };
      }
      const start: WindowStart = { folder: current, tab: moving };
      await api.windowNew({ start, session, x: at?.x ?? null, y: at?.y ?? null });
    } catch (e) {
      terminal?.cancelMove();
      toast("error", toAppError(e).message);
      return;
    }
    // The tab lives on in the new window: no save prompt, and the terminal's shell keeps running.
    removeTab(id);
  };

  // ---- Menus ----

  const fileMenu = (e: ReactMouseEvent, entries: Entry[], actions: { newFile: () => void; newFolder: () => void; rename: () => void }) => {
    const root = latest.current.folder!;
    const items: MenuEntry[] = [];
    if (entries.length > 1) {
      // Several selected: what works on all of them at once.
      const paths = entries.map((x) => x.path);
      items.push(
        { label: `Mention ${entries.length} Items in Claude`, icon: <AtSign size={14} />, onSelect: () => mentionInClaude(paths) },
        "separator",
        { label: "Copy Paths", icon: <Copy size={14} />, onSelect: () => void writeText(paths.join("\n")) },
        { label: "Copy Relative Paths", icon: <Copy size={14} />, onSelect: () => void writeText(paths.map((p) => relative(root, p)).join("\n")) },
        "separator",
        { label: `Move ${entries.length} Items to Trash`, icon: <Trash2 size={14} />, danger: true, onSelect: () => trashEntries(entries) },
      );
      setMenu({ x: e.clientX, y: e.clientY, items });
      return;
    }
    const entry = entries[0] ?? null;
    if (entry) {
      if (!entry.dir) items.push({ label: "Open", icon: <FolderOpen size={14} />, onSelect: () => openFile(entry.path, true) });
      items.push(
        { label: "Mention in Claude", icon: <AtSign size={14} />, onSelect: () => mentionInClaude([entry.path]) },
        { label: "Open in Terminal", icon: <SquareTerminal size={14} />, onSelect: () => newTerminal(false, entry.dir ? entry.path : dirname(entry.path)) },
        { label: "Reveal in Finder", icon: <FolderOpen size={14} />, onSelect: () => void revealItemInDir(entry.path) },
        "separator",
        { label: "Copy Path", icon: <Copy size={14} />, onSelect: () => void writeText(entry.path) },
        { label: "Copy Relative Path", icon: <Copy size={14} />, onSelect: () => void writeText(relative(root, entry.path)) },
        "separator",
      );
    }
    items.push(
      { label: "New File…", icon: <FilePlus2 size={14} />, onSelect: actions.newFile },
      { label: "New Folder…", icon: <FolderPlus size={14} />, onSelect: actions.newFolder },
    );
    if (entry) {
      items.push(
        "separator",
        { label: "Rename…", icon: <Pencil size={14} />, onSelect: actions.rename },
        { label: "Move to Trash", icon: <Trash2 size={14} />, danger: true, onSelect: () => trashEntries([entry]) },
      );
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const tabMenu = (e: ReactMouseEvent, tab: Tab) => {
    const items: MenuEntry[] = [
      { label: "Close", icon: <X size={14} />, shortcut: "⌘W", onSelect: () => closeTab(tab.id) },
      {
        label: "Close Others",
        onSelect: () => {
          setActiveId(tab.id);
          for (const t of tabsIn(latest.current.tabs, tab.group ?? "")) if (t.id !== tab.id) closeTab(t.id);
        },
      },
    ];
    const g = tab.group ?? currentGroup();
    const full = panesOf(latest.current.layout).length >= MAX_PANES;
    const alone = tabsIn(latest.current.tabs, g).length < 2;
    items.push(
      "separator",
      { label: "Split Terminal", icon: <Split size={14} />, shortcut: "⌘D", disabled: full, onSelect: () => void splitTerminal("right", g) },
      { label: "Split Terminal Down", icon: <SplitDown size={14} />, shortcut: "⇧⌘D", disabled: full, onSelect: () => void splitTerminal("bottom", g) },
      { label: "Move to New Group on the Right", icon: <MoveOut size={14} />, disabled: full || alone, onSelect: () => splitWith(tab.id, g, "right") },
      { label: "Move to New Group Below", icon: <MoveOut size={14} />, disabled: full || alone, onSelect: () => splitWith(tab.id, g, "bottom") },
    );
    if (latest.current.tabs.length > 1) {
      items.push("separator", { label: "Move to New Window", icon: <AppWindow size={14} />, onSelect: () => void moveToNewWindow(tab.id) });
    }
    if (tab.kind === "file") {
      items.push(
        "separator",
        { label: "Mention in Claude", icon: <AtSign size={14} />, onSelect: () => mentionInClaude([tab.path]) },
        { label: "Reveal in Finder", icon: <FolderOpen size={14} />, onSelect: () => void revealItemInDir(tab.path) },
        { label: "Copy Path", icon: <Copy size={14} />, onSelect: () => void writeText(tab.path) },
      );
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ---- Keyboard ----

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const { activeId: current } = latest.current;
      // Moving between tabs stays in the group in use.
      const list = tabsIn(latest.current.tabs, currentGroup());
      const key = e.key.toLowerCase();
      const go = (delta: number) => {
        const i = list.findIndex((t) => t.id === current);
        if (list.length) setActiveId(list[(i + delta + list.length) % list.length].id);
      };
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        return go(e.shiftKey ? -1 : 1);
      }
      if (e.ctrlKey && e.shiftKey && key === "g") {
        e.preventDefault();
        return setPanel((p) => (p === "git" ? null : "git"));
      }
      if (!e.metaKey) return;
      const run = (f: () => void) => {
        e.preventDefault();
        f();
      };
      if (key === "t") return run(() => newTerminal(e.shiftKey));
      if (key === "y") return run(() => setHistorySignal((n) => n + 1));
      if (key === "p" && e.shiftKey) return run(() => setPalette(true));
      if (key === "d") return run(() => void splitTerminal(e.shiftKey ? "bottom" : "right"));
      // ⌥⌘ and an arrow goes to the group on that side.
      const arrow = ({ arrowleft: "left", arrowright: "right", arrowup: "top", arrowdown: "bottom" } as const)[key as "arrowleft"];
      if (e.altKey && arrow) {
        const { tabs: all, layout: lay, groupShown: shown } = latest.current;
        const next = paneTowards(lay, currentGroup(), arrow);
        const tab = next ? shownIn(all, next, shown, null) : undefined;
        return run(() => tab && setActiveId(tab.id));
      }
      if (key === "n" && !e.shiftKey) return run(newWindow);
      if (key === "w" && e.shiftKey) return run(() => void getCurrentWindow().close());
      if (key === "w") return run(() => current && closeTab(current));
      if (key === "o") return run(() => void chooseFolder());
      if (key === "b") return run(() => setPanel((p) => (p ? null : "files")));
      if (key === "p" && !e.shiftKey && latest.current.folder) return run(() => setQuickOpen(true));
      if (e.shiftKey && key === "e") return run(() => setPanel((p) => (p === "files" ? null : "files")));
      if (e.shiftKey && key === "f") return run(() => (setPanel("search"), setSearchToken((t) => t + 1)));
      if (e.shiftKey && (e.key === "[" || e.key === "{")) return run(() => go(-1));
      if (e.shiftKey && (e.key === "]" || e.key === "}")) return run(() => go(1));
      if (/^[1-9]$/.test(e.key)) return run(() => setActiveId((key === "9" ? list[list.length - 1] : list[Number(key) - 1])?.id ?? current));
      if (key === "=" || key === "+") return run(() => setFontSize((s) => Math.min(24, s + 1)));
      if (key === "-") return run(() => setFontSize((s) => Math.max(9, s - 1)));
      if (key === "0") return run(() => setFontSize(13));
      const tab = latest.current.tabs.find((t) => t.id === current);
      if (tab?.kind === "terminal") {
        if (key === "k") return run(() => terminals.get(tab.id)?.clear());
        if (key === "f") return run(() => terminals.get(tab.id)?.find());
      }
      if (tab?.kind === "file") {
        // ⇧⌘V switches a Markdown file between its page and the editor, as in VS Code.
        if (e.shiftKey && key === "v" && isMarkdown(tab.path)) return run(() => editors.get(tab.id)?.toggleRendered());
        // The editor handles ⌘F itself; this is for a Markdown page.
        if (key === "f" && !e.shiftKey && !e.defaultPrevented) return run(() => editors.get(tab.id)?.find());
      }
      if (key === "r") e.preventDefault(); // ⌘R would reload the web view.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newTerminal, closeTab, currentGroup, chooseFolder, newWindow, splitTerminal]);

  // Unsaved files are offered for saving before the window closes.
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested(async (event) => {
      // Closing one of several windows forgets its Claude tabs; the last window keeps them for the next launch.
      const others = (await getAllWebviewWindows()).filter((w) => w.label !== appWindow.label && (w.label === "main" || w.label.startsWith("w-")));
      if (others.length > 0) {
        try {
          localStorage.removeItem(CLAUDE_TABS_KEY + appWindow.label);
        } catch {
          // Then they reopen at the next launch, which is harmless.
        }
      }
      const dirty = latest.current.tabs.filter((t) => t.kind === "file" && t.dirty);
      if (dirty.length === 0) return;
      event.preventDefault();
      setDialog({
        type: "choice",
        title: dirty.length === 1 ? "Save changes before closing?" : `Save changes to ${dirty.length} files before closing?`,
        message: "Your changes are lost if you don't save them.",
        actions: [
          { label: "Don't Save", kind: "danger-ghost", onClick: () => void getCurrentWindow().destroy() },
          {
            label: "Save All",
            kind: "primary",
            onClick: async () => {
              setDialog(null);
              for (const t of dirty) if (!(await editors.get(t.id)?.save())) return;
              void getCurrentWindow().destroy();
            },
          },
        ],
      });
    });
    return () => void un.then((f) => f());
  }, []);

  useEffect(() => {
    if (quickOpen && folder && !quickFiles) void api.listFiles(folder).then(setQuickFiles);
  }, [quickOpen, folder, quickFiles]);

  // ---- Side panel resize ----

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sideWidth;
    const move = (ev: MouseEvent) => setSideWidth(Math.max(180, Math.min(600, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("col-resizing");
      setSideWidth((w) => (localStorage.setItem(SIDE_KEY, String(w)), w));
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /** Drags a line between groups. */
  const startSplitResize = (e: ReactMouseEvent, line: Divider) => {
    e.preventDefault();
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const row = line.dir === "row";
    const start = row ? box.left + line.area.x * box.width : box.top + line.area.y * box.height;
    const length = row ? line.area.w * box.width : line.area.h * box.height;
    const min = Math.min(0.45, MIN_PANE[line.dir] / length);
    const cursor = row ? "col-resizing" : "row-resizing";
    const move = (ev: MouseEvent) => {
      const at = ((row ? ev.clientX : ev.clientY) - start) / length;
      setLayout((l) => resizeSplit(l, line.path, line.index, at, min));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove(cursor);
    };
    document.body.classList.add(cursor);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /** A tab dragged out of its bar, at x, y in the window: works out where a
   * drop there puts it, as in VS Code, and shows it. Over another group's tabs
   * it goes in among them, over the middle of a group it moves into that
   * group, over an edge it gets a new group on that side, and out of the
   * window it gets a window of its own. */
  const dragOver = (id: string, x: number | null, y: number | null): DragMode => {
    const set = (target: DropTarget | null) => {
      if (JSON.stringify(dropRef.current) === JSON.stringify(target)) return;
      dropRef.current = target;
      setDrop(target);
    };
    const { tabs: list, layout: lay } = latest.current;
    const tab = list.find((t) => t.id === id);
    if (x === null || y === null || !tab) {
      set(null);
      return "none";
    }
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      const out = list.length > 1;
      set(out ? { kind: "out" } : null);
      return out ? "out" : "none";
    }
    for (const [g, el] of bars.current) {
      if (g === tab.group) continue;
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top - 8 || y > r.bottom + 12) continue;
      const others = [...el.querySelectorAll<HTMLElement>(":scope > .tab")];
      let index = others.findIndex((t) => {
        const b = t.getBoundingClientRect();
        return x < b.left + b.width / 2;
      });
      if (index < 0) index = others.length;
      set({ kind: "strip", group: g, index });
      return "move";
    }
    const box = panesRef.current?.getBoundingClientRect();
    if (!box || x < box.left || x > box.right || y < box.top || y > box.bottom) {
      set(null);
      return "none";
    }
    const fx = (x - box.left) / box.width;
    const fy = (y - box.top) / box.height;
    let group: string | null = null;
    let rect: Rect | null = null;
    for (const [g, r] of paneRects(lay)) {
      if (fx >= r.x && fx <= r.x + r.w && fy >= r.y && fy <= r.y + r.h) {
        group = g;
        rect = r;
      }
    }
    if (!group || !rect) {
      set(null);
      return "none";
    }
    const dx = (fx - rect.x) / rect.w;
    const dy = (fy - rect.y) / rect.h;
    // Within this share of an edge, a drop splits the group; nearer the middle it moves the tab into it.
    const edge = Math.min(dx, 1 - dx, dy, 1 - dy) < 0.3;
    const alone = tabsIn(list, group).length === 1 && group === tab.group;
    if (!edge || alone) {
      if (group === tab.group) {
        set(null);
        return "none";
      }
      set({ kind: "move", group, rect });
      return "move";
    }
    if (panesOf(lay).length >= MAX_PANES) {
      set({ kind: "full", group, rect });
      return "full";
    }
    const side = sideAt(rect, fx, fy);
    set({ kind: "split", group, side, rect: halfOf(rect, side) });
    return "split";
  };

  /** The drag ended: with `dropped`, the tab goes where dragOver showed. */
  const dragEnd = (id: string, dropped: boolean, screenX: number, screenY: number) => {
    const target = dropRef.current;
    dropRef.current = null;
    setDrop(null);
    if (!dropped || !target) return;
    if (target.kind === "out") return void moveToNewWindow(id, { x: screenX, y: screenY });
    if (target.kind === "strip") return moveToGroup(id, target.group, target.index);
    if (target.kind === "move") return moveToGroup(id, target.group);
    if (target.kind === "split") return splitWith(id, target.group, target.side);
  };

  /** Conversations open in a tab here, by Claude session id. */
  const openSessions = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tabs) if (t.kind === "terminal" && t.claudeSession) map.set(t.claudeSession, t.id);
    return map;
  }, [tabs]);

  /** This window's terminal sessions, for the ports list. */
  const terminalSessions = useMemo(() => {
    const map = new Map<string, { tabId: string; title: string }>();
    for (const t of tabs) if (t.kind === "terminal" && t.sessionId) map.set(t.sessionId, { tabId: t.id, title: t.title });
    return map;
  }, [tabs]);

  // ---- Render ----

  const focusedGroup = active?.group && groups.includes(active.group) ? active.group : groups[0];

  /** Gives a tab the keyboard once it is drawn, after a click on it or a drag. */
  const focusTab = (id: string) =>
    requestAnimationFrame(() => requestAnimationFrame(() => (terminals.get(id) ?? editors.get(id))?.focus()));

  /** A click or focus in a group's view makes its tab the one in use. */
  const takeTabAt = (target: EventTarget) => {
    const id = (target as HTMLElement).closest?.("[data-tab]")?.getAttribute("data-tab");
    if (id && id !== latest.current.activeId && latest.current.tabs.some((t) => t.id === id)) setActiveId(id);
  };

  /** The tabs of the group `g`, with buttons for a new terminal and a new Claude session in it. */
  const groupBar = (g: string, className?: string, style?: CSSProperties) => (
    <TabBar
      key={g}
      tabs={tabsIn(tabs, g)}
      activeId={shownIn(tabs, g, groupShown, activeId)?.id ?? null}
      focused={g === focusedGroup}
      dropIndex={drop?.kind === "strip" && drop.group === g ? drop.index : null}
      label={tabLabel}
      status={tabStatus}
      tip={tabTip}
      onActivate={(id) => {
        setActiveId(id);
        focusTab(id);
      }}
      onClose={(id) => closeTab(id)}
      onPin={(id) => setTabs((l) => l.map((t) => (t.id === id && t.kind === "file" ? { ...t, preview: false } : t)))}
      onMenu={tabMenu}
      onMove={(id, index) => moveToGroup(id, g, index)}
      onDragOver={dragOver}
      onDragEnd={(id, dropped, x, y) => {
        dragEnd(id, dropped, x, y);
        focusTab(id);
      }}
      barRef={(el) => {
        if (el) bars.current.set(g, el);
        else bars.current.delete(g);
      }}
      className={className}
      style={style}
    >
      <button type="button" className="tab-new" title="New Terminal (⌘T)" onClick={() => newTerminal(false, undefined, g)}>
        <Plus size={15} />
      </button>
      <button type="button" className="tab-new claude" title="New Claude Session (⇧⌘T)" onClick={() => newTerminal(true, undefined, g)}>
        <Claude size={17} />
      </button>
    </TabBar>
  );

  /** The dot on a tab: what Claude is doing in it. */
  const tabStatus = (tab: Tab): ClaudeState | undefined => (tab.kind === "terminal" ? tab.claudeState : undefined);

  /** A terminal tab's tooltip: the Claude conversation's usage so far. */
  const tabTip = (tab: Tab): string | undefined => {
    if (tab.kind !== "terminal" || !tab.claude) return undefined;
    const state = tab.claudeState === "working" ? "Claude is working" : tab.claudeState === "waiting" ? "Claude needs your input" : tab.claudeState === "done" ? "Claude finished" : null;
    const usage = tab.usage ? `${formatTokens(tab.usage.tokens)} tokens${tab.usage.cost !== null ? `, ${formatCost(tab.usage.cost)}` : ""}` : null;
    return [tab.title, state, usage].filter(Boolean).join(" · ");
  };

  /** What ⇧⌘P offers. */
  const paletteCommands = (): PaletteCommand[] => {
    const current = active;
    const commands: PaletteCommand[] = [
      { id: "new-terminal", label: "New Terminal", icon: <SquareTerminal size={14} />, shortcut: "⌘T", run: () => newTerminal(false) },
      { id: "new-claude", label: "New Claude Session", icon: <Claude size={14} />, shortcut: "⇧⌘T", run: () => newTerminal(true) },
      { id: "history", label: "Claude History", icon: <History size={14} />, shortcut: "⌘Y", run: () => setHistorySignal((n) => n + 1) },
      {
        id: "resume",
        label: "Continue Conversation…",
        icon: <Claude size={14} />,
        keywords: "resume claude history",
        run: async () =>
          (await api.claudeSessions().catch(() => [])).map((session) => ({
            id: session.id,
            label: session.title ?? session.prompt ?? session.id,
            icon: <Claude size={14} />,
            keywords: `${basename(session.cwd)} ${session.prompt ?? ""}`,
            run: () => (openSessions.has(session.id) ? showTab(openSessions.get(session.id)!) : addTab(resumeTab(session.id, session.cwd, session.title))),
          })),
      },
    ];
    commands.push(
      { id: "split", label: "Split Terminal", icon: <Split size={14} />, shortcut: "⌘D", run: () => void splitTerminal("right") },
      { id: "split-down", label: "Split Terminal Down", icon: <SplitDown size={14} />, shortcut: "⇧⌘D", run: () => void splitTerminal("bottom") },
    );
    if (current?.kind === "terminal") {
      commands.push({ id: "clear", label: "Clear Terminal", icon: <SquareTerminal size={14} />, shortcut: "⌘K", run: () => terminals.get(current.id)?.clear() });
    }
    commands.push(
      { id: "open-folder", label: "Open Folder…", icon: <FolderOpen size={14} />, shortcut: "⌘O", run: () => void chooseFolder() },
      {
        id: "open-recent",
        label: "Open Recent Folder…",
        icon: <FolderOpen size={14} />,
        run: () => recent.map((path) => ({ id: path, label: basename(path), keywords: path, icon: <FolderOpen size={14} />, run: () => void openFolder(path) })),
      },
    );
    if (folder) commands.push({ id: "quick-open", label: "Go to File…", icon: <FileText size={14} />, shortcut: "⌘P", run: () => setQuickOpen(true) });
    if (git) {
      const root = git.root;
      commands.push({
        id: "branch",
        label: "Switch Branch…",
        icon: <GitBranch size={14} />,
        keywords: "git checkout",
        run: async () => {
          const branches = await api.gitBranches(root).catch(() => null);
          if (!branches) return [];
          const locals = new Set(branches.local);
          const remote = branches.remote.map((r) => r.slice(r.indexOf("/") + 1)).filter((b) => !locals.has(b));
          return [...branches.local, ...remote].map((b) => ({
            id: b,
            label: b === branches.current ? `${b} (current)` : b,
            icon: <GitBranch size={14} />,
            run: () => void gitAction("Switching", () => api.gitSwitch(root, b, false), `On ${b}`),
          }));
        },
      });
    }
    commands.push(
      { id: "files", label: "Show Files", icon: <FileText size={14} />, shortcut: "⇧⌘E", run: () => setPanel("files") },
      { id: "search", label: "Search in Files", icon: <FileText size={14} />, shortcut: "⇧⌘F", run: () => (setPanel("search"), setSearchToken((t) => t + 1)) },
      { id: "git", label: "Source Control", icon: <GitBranch size={14} />, shortcut: "⌃⇧G", run: () => setPanel("git") },
      { id: "sidebar", label: "Toggle Sidebar", icon: <FileText size={14} />, shortcut: "⌘B", run: () => setPanel((p) => (p ? null : "files")) },
      {
        id: "theme",
        label: theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode",
        icon: theme === "dark" ? <Sun size={14} /> : <Moon size={14} />,
        keywords: "theme dark light appearance",
        run: () => {
          setThemeSwitched(true);
          setTheme((t) => (t === "dark" ? "light" : "dark"));
        },
      },
      { id: "new-window", label: "New Window", icon: <AppWindow size={14} />, shortcut: "⌘N", run: newWindow },
    );
    if (current) commands.push({ id: "close", label: "Close Tab", icon: <X size={14} />, shortcut: "⌘W", run: () => closeTab(current.id) });
    return commands;
  };

  const tabLabel = (tab: Tab) => {
    if (tab.kind === "terminal") return { icon: tab.claude ? <Claude size={13} className="claude-icon" /> : <SquareTerminal size={13} />, text: tab.title };
    if (tab.kind === "file") return { icon: <img className="tab-file-icon" src={iconUrl(basename(tab.path), false)} alt="" />, text: basename(tab.path) };
    return { icon: <GitCompare size={13} />, text: `${basename(tab.path)}${tab.staged ? " (staged)" : ""}` };
  };

  const activity = (id: Panel, title: string, icon: SidebarIconName, badge?: number) => (
    <button
      type="button"
      className={`activity-button${panel === id ? " active" : ""}`}
      data-tip={title}
      aria-label={title}
      onClick={() => {
        setPanel((p) => (p === id ? null : id));
        if (id === "search") setSearchToken((t) => t + 1);
      }}
    >
      <SidebarIcon name={icon} filled={panel === id} />
      {!!badge && <span className="activity-badge">{badge > 99 ? "99+" : badge}</span>}
    </button>
  );

  const changeCount = git ? git.files.length : 0;

  const settingsMenu = (e: ReactMouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const themeLabel = THEMES.find((t) => t.id === colorTheme)?.label;
    setMenu({
      x: rect.right + 6,
      y: rect.bottom,
      items: [
        {
          label: "Theme",
          icon: <Palette size={14} />,
          detail: themeLabel,
          submenu: {
            title: "Theme",
            note: "Colors of the window, the code in the editor and the text in terminals. Default is Lookout's own colors with One Dark Pro text.",
            items: THEMES.map((t) => {
              const version = themeVersion(t.id, theme);
              const colors = version.syntax;
              return {
                label: t.label,
                icon: <ThemeSwatch bg={(version.window ?? DEFAULT_WINDOW[theme]).bg} colors={[colors.keyword, colors.string, colors.function]} />,
                detail: t.light ? undefined : "Dark mode only",
                checked: t.id === colorTheme,
                onSelect: () => pickTheme(t.id),
              };
            }),
          },
        },
        "separator",
        {
          label: "Code font",
          icon: <Type size={14} />,
          detail: availableFonts().find((f) => f.id === settings.font)?.label ?? "SF Mono",
          submenu: {
            title: "Code font",
            note: "Used in the terminal and the editor. Other coding fonts show up here once installed.",
            items: availableFonts().map((f) => ({
              label: f.label,
              icon: (
                <span className="font-sample" style={{ fontFamily: f.css }}>
                  Aa
                </span>
              ),
              checked: f.id === settings.font,
              onSelect: () => changeSetting("font", f.id),
            })),
          },
        },
        {
          label: "Interface font",
          icon: <Type size={14} />,
          detail: UI_FONTS.find((f) => f.id === settings.uiFont)?.label,
          submenu: {
            title: "Interface font",
            note: "Used in tabs, panels and menus.",
            items: UI_FONTS.map((f) => ({
              label: f.label,
              icon: (
                <span className="font-sample" style={{ fontFamily: f.css }}>
                  Aa
                </span>
              ),
              checked: f.id === settings.uiFont,
              onSelect: () => changeSetting("uiFont", f.id),
            })),
          },
        },
        {
          label: "Font size",
          icon: <ALargeSmall size={14} />,
          detail: `${fontSize} px`,
          submenu: {
            title: "Font size",
            note: "⌘= and ⌘- change it too, and ⌘0 resets it.",
            items: [11, 12, 13, 14, 15, 16, 18, 20].map((size) => ({ label: `${size} px`, checked: size === fontSize, onSelect: () => setFontSize(size) })),
          },
        },
        {
          label: "Line spacing",
          icon: <Rows3 size={14} />,
          detail: LINE_HEIGHTS.find((l) => l.value === settings.lineHeight)?.label,
          submenu: {
            title: "Line spacing",
            note: "Space between lines in the terminal.",
            items: LINE_HEIGHTS.map((l) => ({ label: l.label, checked: l.value === settings.lineHeight, onSelect: () => changeSetting("lineHeight", l.value) })),
          },
        },
        "separator",
        {
          label: "Terminal cursor",
          icon: <TextCursor size={14} />,
          detail: `${CURSOR_LABELS[settings.cursorStyle]}${settings.cursorBlink ? ", blinking" : ""}`,
          submenu: {
            items: [
              ...(["underline", "bar", "block"] as const).map((style) => ({
                label: CURSOR_LABELS[style],
                checked: settings.cursorStyle === style,
                onSelect: () => changeSetting("cursorStyle", style),
              })),
              "separator",
              { label: "Blink", checked: settings.cursorBlink, onSelect: () => changeSetting("cursorBlink", !settings.cursorBlink) },
              "separator",
              ...BLINK_SPEEDS.map((speed) => ({
                label: `${speed.label} blinking`,
                checked: speed.value === settings.blinkMs,
                disabled: !settings.cursorBlink,
                onSelect: () => changeSetting("blinkMs", speed.value),
              })),
            ],
          },
        },
        {
          label: "Key repeat",
          icon: <Keyboard size={14} />,
          detail: KEY_REPEAT[settings.keyRepeat].label,
          submenu: {
            title: "Key repeat",
            note: "How fast ⌫, Delete, ← and → repeat in the terminal while held.",
            items: (["fast", "faster", "system"] as const).map((speed) => ({
              label: KEY_REPEAT[speed].label,
              checked: speed === settings.keyRepeat,
              onSelect: () => changeSetting("keyRepeat", speed),
            })),
          },
        },
        {
          label: "Option key",
          icon: <Option size={14} />,
          detail: settings.optionIsMeta ? "Meta" : "Characters",
          submenu: {
            title: "Option key in the terminal",
            note: "Characters: Option types @, € and other symbols. Meta: Option sends Esc and the key, for shortcuts in tools like Emacs.",
            items: [false, true].map((meta) => ({
              label: meta ? "Meta" : "Characters",
              checked: settings.optionIsMeta === meta,
              onSelect: () => changeSetting("optionIsMeta", meta),
            })),
          },
        },
        {
          label: "Copy on select",
          icon: <ClipboardCopy size={14} />,
          checked: settings.copyOnSelect,
          onSelect: () => changeSetting("copyOnSelect", !settings.copyOnSelect),
        },
        {
          label: "Last login message",
          icon: <LogIn size={14} />,
          checked: settings.lastLogin,
          onSelect: () => changeSetting("lastLogin", !settings.lastLogin),
        },
        {
          label: "Scrollback",
          icon: <ScrollText size={14} />,
          detail: `${settings.scrollback.toLocaleString("en-US")} lines`,
          submenu: {
            title: "Scrollback",
            note: "How many lines of output each terminal keeps.",
            items: SCROLLBACK.map((lines) => ({
              label: `${lines.toLocaleString("en-US")} lines`,
              checked: lines === settings.scrollback,
              onSelect: () => changeSetting("scrollback", lines),
            })),
          },
        },
        "separator",
        {
          label: "Element picker",
          icon: <SidebarIcon name="pick" size={14} />,
          detail: "⌥⌘E",
          checked: settings.picker,
          onSelect: () => changeSetting("picker", !settings.picker),
        },
        {
          label: "Word wrap in editor",
          icon: <TextWrap size={14} />,
          checked: settings.wordWrap,
          onSelect: () => changeSetting("wordWrap", !settings.wordWrap),
        },
        {
          label: "Mac notifications",
          icon: <Bell size={14} />,
          checked: settings.banners,
          onSelect: () => changeSetting("banners", !settings.banners),
        },
        {
          label: "Reopen Claude tabs at launch",
          icon: <History size={14} />,
          checked: settings.restoreClaude,
          onSelect: () => changeSetting("restoreClaude", !settings.restoreClaude),
        },
        "separator",
        {
          label: "Memes",
          icon: <Cat size={14} />,
          detail: memes ? "On" : "Off",
          submenu: {
            items: [true, false].map((on) => ({
              label: on ? "Enable" : "Disable",
              checked: memes === on,
              onSelect: () => {
                setMemes(on);
                localStorage.setItem(MEMES_KEY, on ? "1" : "0");
              },
            })),
          },
        },
      ],
    });
  };

  const projectMenu = (e: ReactMouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuEntry[] = [
      { label: "Open Folder…", icon: <FolderOpen size={14} />, shortcut: "⌘O", onSelect: () => void chooseFolder() },
      { label: "New Window", icon: <AppWindow size={14} />, shortcut: "⌘N", onSelect: newWindow },
    ];
    if (recent.length) {
      items.push(
        "separator",
        ...recent.slice(0, 10).map((path) => ({
          label: `${basename(path)}  ${tildify(dirname(path), home)}`,
          icon: <img className="tree-icon" src={iconUrl(basename(path), true)} alt="" />,
          checked: path === folder,
          onSelect: () => void openFolder(path),
        })),
      );
    }
    setMenu({ x: rect.right + 6, y: Math.max(8, rect.bottom - 40 - items.length * 28), items });
  };

  return (
    <div className={`app${compact ? " compact" : ""}`} style={{ ["--side-w" as string]: panel ? `${sideWidth}px` : "0px" }}>
      <header className="titlebar" data-tauri-drag-region>
        <div className="titlebar-left" data-tauri-drag-region>
          <span className="brand" data-tauri-drag-region>
            <BrandMark />
            <span className="brand-name" data-tauri-drag-region>
              Lookout
            </span>
          </span>
          {folder && (
            <span className="titlebar-folder" data-tauri-drag-region title={folder}>
              {basename(folder)}
              {git?.branch && (
                <span className="titlebar-branch" data-tauri-drag-region>
                  <GitBranch size={11} /> {git.branch}
                </span>
              )}
            </span>
          )}
        </div>
        {/* The tabs of the groups along the top, each above its group. */}
        <div className="titlebar-tabs" ref={titleTabsRef} data-tauri-drag-region>
          {groups.map((g) => {
            const r = rects.get(g)!;
            if (!atTop(r)) return null;
            return groupBar(g, r.x > 1e-6 ? "in-title after-split" : "in-title", {
              left: `max(0px, calc(var(--cl, 0px) + var(--cw, 100%) * ${r.x}))`,
              right: `max(0px, calc(100% - var(--cl, 0px) - var(--cw, 100%) * ${r.x + r.w}))`,
            });
          })}
        </div>
        <div className="titlebar-actions">
          <ThemePicker current={colorTheme} mode={theme} onPick={pickTheme} />
          <UpdateButton app="Lookout" repo="lakiAlex/lookout" restartNote="Running terminals end." notify={settings.banners} />
          {git && <GitChip status={git} open={panel === "git"} onClick={() => setPanel((p) => (p === "git" ? null : "git"))} />}
          <WindowSnap />
          <button
            type="button"
            role="switch"
            aria-checked={theme === "dark"}
            className={`theme-switch ${theme}${themeSwitched ? " switched" : ""}`}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={() => {
              setThemeSwitched(true);
              setTheme((t) => (t === "dark" ? "light" : "dark"));
            }}
          >
            <span className="theme-thumb" />
            <span className="theme-option sun">
              <Sun size={15} strokeWidth={1.9} />
            </span>
            <span className="theme-option moon">
              <Moon size={12.5} strokeWidth={1.9} />
            </span>
          </button>
          <div className="titlebar-icons">
            <PortsButton sessions={terminalSessions} onShowTab={showTab} />
            <HistoryButton
              folder={folder}
              openSessions={openSessions}
              openSignal={historySignal}
              onResume={(session) => addTab(resumeTab(session.id, session.cwd, session.title))}
              onActivate={showTab}
              onRenamed={(sessionId, name) =>
                setTabs((l) => l.map((t) => (t.kind === "terminal" && t.claudeSession === sessionId ? { ...t, sessionName: name, title: t.claude ? name : t.title } : t)))
              }
              onError={(message) => toast("error", message)}
            />
            <NotificationBell notices={notices} onOpen={(n) => void api.noticeOpen(n.id)} />
          </div>
        </div>
      </header>

      <nav className="activity-bar">
        <div className="activity-group">
          {activity("files", "Files (⇧⌘E)", "files")}
          {activity("search", "Search (⇧⌘F)", "search")}
          {activity("git", "Source Control (⌃⇧G)", "git", changeCount)}
        </div>
        {settings.picker && (
          <button
            type="button"
            className="activity-button activity-pick"
            data-tip="Pick an element on screen (⌥⌘E)" aria-label="Pick an element on screen (⌥⌘E)"
            onClick={() => void api.pickerStart()}
          >
            <SidebarIcon name="pick" />
          </button>
        )}
        <span className="activity-spacer" />
        <div className="activity-group">
          <button type="button" className="activity-button" data-tip="Open a project" aria-label="Open a project" onClick={projectMenu}>
            <SidebarIcon name="folder" />
          </button>
          <button
            type="button"
            className="activity-button"
            data-tip={compact ? "Expand sidebar" : "Minimize sidebar"} aria-label={compact ? "Expand sidebar" : "Minimize sidebar"}
            onClick={() => {
              setCompact(!compact);
              localStorage.setItem(COMPACT_KEY, compact ? "0" : "1");
            }}
          >
            <SidebarIcon name="sidebar" />
          </button>
          <button type="button" className="activity-button" data-tip="Settings" aria-label="Settings" onClick={settingsMenu}>
            <SidebarIcon name="settings" />
          </button>
        </div>
      </nav>

      <aside className="side-panel">
        {sidePanel && folder && (
          <div key={sidePanel} className="side-panel-body">
            {sidePanel === "files" && (
              <FilesPanel
                root={folder}
                onClose={() => setPanel(null)}
                marks={marks}
                activePath={active?.kind === "file" ? active.path : null}
                onOpen={(path, pin) => openFile(path, pin)}
                onMenu={fileMenu}
                onTrash={trashEntries}
                onMoved={filesMoved}
                onError={(m) => toast("error", m)}
              />
            )}
            {sidePanel === "search" && (
              <SearchPanel root={folder} onClose={() => setPanel(null)} focusToken={searchToken} onOpen={(path, line, from, to) => openFile(path, false, { line, from, to })} />
            )}
            {sidePanel === "git" && (
              <GitPanel
                status={git}
                onClose={() => setPanel(null)}
                busy={gitBusy}
                onRefresh={() => void refreshGit()}
                onCommit={commit}
                onStage={(paths) => git && void gitAction("Staging", () => api.gitStage(git.root, paths))}
                onUnstage={(paths) => git && void gitAction("Unstaging", () => api.gitUnstage(git.root, paths))}
                onDiscard={discard}
                onDiff={(file, staged) => git && openDiff(git.root, file.path, staged)}
                onOpen={(file) => git && openFile(`${git.root}/${file.path}`, true)}
                onSync={sync}
                onBranchMenu={(e) => void branchMenu(e)}
              />
            )}
          </div>
        )}
        {sidePanel && !folder && (
          <div className="panel-open-folder">
            <p>Open a folder to see its files, search it and use git.</p>
            <button type="button" className="button small" onClick={() => void chooseFolder()}>
              <FolderOpen size={13} /> Open Folder…
            </button>
          </div>
        )}
        {panel && <div className="side-resize" onMouseDown={startResize} />}
      </aside>

      <main className="content">
        {memes && <MemeButton />}
        {clipNote && (
          <div key={clipNote.key} className={`clip-note${memes ? " above-meme" : ""}${clipNote.leaving ? " leaving" : ""}`} role="status">
            <Check size={13} /> {clipNote.text}
          </div>
        )}
        {/* Every tab's view, at its group's place; each group shows one. They
            stay in this one parent, so a tab moved to another group keeps its
            terminal or editor running. */}
        <div
          className="panes"
          ref={panesRef}
          onPointerDownCapture={(e) => takeTabAt(e.target)}
          onFocusCapture={(e) => takeTabAt(e.target)}
        >
          {groups.map((g) => {
            const r = rects.get(g)!;
            if (atTop(r)) return null;
            return (
              <div key={g} className="group-tabs" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: GROUP_TABS }}>
                {groupBar(g)}
              </div>
            );
          })}
          {tabs.map((tab) => {
            const g = tab.group && rects.has(tab.group) ? tab.group : groups[0];
            const r = rects.get(g)!;
            const style = groups.length > 1 ? rectStyle(r, atTop(r) ? 0 : GROUP_TABS) : undefined;
            const shown = shownIn(tabs, g, groupShown, activeId)?.id === tab.id;
            const primary = tab.id === activeId;
            if (tab.kind === "terminal") {
              return (
                <TerminalView
                  key={tab.id}
                  tabId={tab.id}
                  cwd={tab.cwd}
                  run={tab.run}
                  sessionId={tab.snapshot !== undefined ? tab.sessionId : null}
                  snapshot={tab.snapshot}
                  active={shown}
                  inSplit={groups.length > 1}
                  primary={primary}
                  onClipboard={noteClipboard}
                  style={style}
                  theme={theme}
                  colorTheme={colorTheme}
                  fontSize={fontSize}
                  settings={settings}
                  // The screen copy of a moved tab is not needed once its session is attached.
                  onSession={(sessionId) => setTabs((l) => l.map((t) => (t.id === tab.id && t.kind === "terminal" ? { ...t, sessionId, snapshot: undefined } : t)))}
                  onEvent={(event) => void terminalEvent(tab.id, event)}
                />
              );
            }
            if (tab.kind === "file") {
              return (
                <EditorView
                  key={tab.id}
                  tabId={tab.id}
                  path={tab.path}
                  active={shown}
                  primary={primary}
                  style={style}
                  reveal={tab.reveal}
                  text={tab.text}
                  wordWrap={settings.wordWrap}
                  onDirty={(dirty) =>
                    setTabs((l) => l.map((t) => (t.id === tab.id && t.kind === "file" ? { ...t, dirty, preview: dirty ? false : t.preview } : t)))
                  }
                  onSaved={() => void refreshGit()}
                  onError={(m) => toast("error", m)}
                  onOpenFile={(path) => openFile(path, true)}
                />
              );
            }
            return (
              <DiffView
                key={tab.id}
                tabId={tab.id}
                root={tab.root}
                path={tab.path}
                staged={tab.staged}
                active={shown}
                style={style}
                version={dataVersion}
                onOpenFile={() => openFile(`${tab.root}/${tab.path}`, true)}
              />
            );
          })}
          {groups.length > 1 &&
            dividers(layout).map((line) => (
              <div
                key={`${line.path.join(".")}:${line.index}`}
                className={`split-divider ${line.dir}`}
                style={
                  line.dir === "row"
                    ? { left: `${line.at * 100}%`, top: `${line.area.y * 100}%`, height: `${line.area.h * 100}%` }
                    : { top: `${line.at * 100}%`, left: `${line.area.x * 100}%`, width: `${line.area.w * 100}%` }
                }
                onMouseDown={(e) => startSplitResize(e, line)}
              />
            ))}
          {drop && (drop.kind === "move" || drop.kind === "split" || drop.kind === "full") && (
            <div className={`drop-zone${drop.kind === "full" ? " full" : ""}`} style={rectStyle(drop.rect)} />
          )}
        </div>
        {picks.length > 0 && active?.kind === "terminal" && (
          <div className="pick-strip">
            <span className="pick-strip-title">Picked</span>
            {picks.map((p) => (
              <button key={p.id} type="button" className="pick-chip" title={`Send to Claude again\n${p.label}`} onClick={() => sendPick(p)}>
                {p.image && <img src={convertFileSrc(p.image)} alt="" />}
                <span>{p.label}</span>
                <span
                  className="pick-remove"
                  title="Remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPicks((list) => list.filter((x) => x.id !== p.id));
                  }}
                >
                  <X size={11} />
                </span>
              </button>
            ))}
          </div>
        )}
        {tabs.length === 0 && started && (
          <div className="welcome">
            <div className="welcome-card">
              <img className="welcome-icon" src={appIcon} alt="" />
              <h3>Lookout</h3>
              <p className="muted">Open a project folder to get files, search and git next to your terminals.</p>
              <div className="welcome-actions">
                <button type="button" className="button primary" onClick={() => void chooseFolder()}>
                  <FolderOpen size={14} /> Open Folder… <span className="kbd">⌘O</span>
                </button>
                <button type="button" className="button" onClick={() => newTerminal(false)}>
                  <SquareTerminal size={14} /> New Terminal <span className="kbd">⌘T</span>
                </button>
                <button type="button" className="button" onClick={() => newTerminal(true)}>
                  <Claude size={14} /> New Claude Session <span className="kbd">⇧⌘T</span>
                </button>
              </div>
              {recent.length > 0 && (
                <div className="welcome-recent">
                  <div className="recent-title">Recent folders</div>
                  {recent.slice(0, 8).map((path) => (
                    <button key={path} type="button" className="recent-folder" onClick={() => void openFolder(path)}>
                      <img className="tree-icon" src={iconUrl(basename(path), true)} alt="" />
                      <span className="tree-name">{basename(path)}</span>
                      <span className="result-dir">{tildify(dirname(path), home)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {quickOpen && folder && (
        <QuickOpen
          files={quickFiles}
          onClose={() => setQuickOpen(false)}
          onOpen={(rel) => {
            setQuickOpen(false);
            openFile(`${folder}/${rel}`, true);
          }}
        />
      )}
      {palette && <CommandPalette commands={paletteCommands()} onClose={() => setPalette(false)} />}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {dialog?.type === "choice" && (
        <ChoiceDialog title={dialog.title} message={dialog.message} actions={dialog.actions} onCancel={() => setDialog(null)} />
      )}
      {dialog?.type === "input" && (
        <InputDialog
          title={dialog.title}
          label={dialog.label}
          initial={dialog.initial}
          confirmLabel={dialog.confirm}
          onCancel={() => setDialog(null)}
          onConfirm={dialog.onConfirm}
        />
      )}
      <NoticePeeks
        peeks={peeks}
        onOpen={(n) => void api.noticeOpen(n.id)}
        onDone={(id) => setPeeks((list) => list.filter((n) => n.id !== id))}
      />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A small preview of a theme: three of its colors on the app's background. */
function ThemeSwatch({ bg, colors }: { bg: string; colors: string[] }) {
  return (
    <span className="theme-swatch" style={{ background: bg }}>
      {colors.map((c, i) => (
        <i key={i} style={{ background: c }} />
      ))}
    </span>
  );
}

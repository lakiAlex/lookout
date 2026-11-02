import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ALargeSmall,
  AppWindow,
  AtSign,
  Bell,
  ClipboardCopy,
  Code,
  Copy,
  Cat,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCompare,
  Keyboard,
  LogIn,
  Moon,
  Option,
  Pencil,
  Plus,
  Rows3,
  ScrollText,
  Sparkle,
  SquareTerminal,
  Sun,
  TextCursor,
  TextWrap,
  Type,
  Terminal,
  Trash2,
  X,
} from "./components/icons";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { api, basename, dirname, relative, tildify, toAppError, type AppError, type Entry, type GitFile, type GitStatus, type Notice, type Pick } from "./api";
import { SidebarIcon, type SidebarIconName } from "./components/SidebarIcon";
import { MemeButton } from "./components/Meme";
import { ContextMenu, type MenuEntry, type MenuState } from "./components/ContextMenu";
import { ChoiceDialog, InputDialog } from "./components/Dialogs";
import { DiffView } from "./components/DiffView";
import { editors, EditorView } from "./components/EditorView";
import { FilesPanel, type GitMark } from "./components/FilesPanel";
import { GitChip } from "./components/GitChip";
import { GitPanel } from "./components/GitPanel";
import { noticeFor, NoticePeeks, NotificationBell } from "./components/Notifications";
import { QuickOpen } from "./components/QuickOpen";
import { SearchPanel } from "./components/SearchPanel";
import { TabBar } from "./components/TabBar";
import { terminals, TerminalView, type TerminalEvent } from "./components/TerminalView";
import { EDITOR_THEME_KEY, EDITOR_THEMES, editorColors, savedEditorTheme } from "./lib/editorThemes";
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
import { newTabId, type Reveal, type Tab, type WindowStart } from "./lib/tabs";
import { savedTerminalTheme, TERMINAL_THEME_KEY, TERMINAL_THEMES, terminalColors } from "./lib/terminalThemes";
import { iconUrl } from "./icons";

const THEME_KEY = "lookout.theme";
const SIDE_KEY = "lookout.sideWidth";
const FONT_KEY = "lookout.fontSize";
const COMPACT_KEY = "lookout.compactBar";
const MEMES_KEY = "lookout.memes";
const SETTINGS_KEY = "lookout.settings";
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

function markFor(file: GitFile): GitMark {
  if (file.index === "U") return { letter: "!", kind: "conflict" };
  if (file.work === "?") return { letter: "U", kind: "untracked" };
  const letter = file.work !== "." ? file.work : file.index;
  if (letter === "D") return { letter: "D", kind: "deleted" };
  if (letter === "A") return { letter: "A", kind: "added" };
  if (letter === "R") return { letter: "R", kind: "renamed" };
  return { letter: "M", kind: "modified" };
}

export default function App() {
  const [folder, setFolder] = useState<string | null>(null);
  const [home, setHome] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [started, setStarted] = useState(false);
  // The side panel opens from the icons on the left and is closed at start.
  const [panel, setPanel] = useState<Panel | null>(null);
  const [sideWidth, setSideWidth] = useState(() => Number(localStorage.getItem(SIDE_KEY)) || 280);
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
  const [terminalTheme, setTerminalTheme] = useState(savedTerminalTheme);
  /** Set on the first click, so the switch's stretch animation does not play at startup. */
  const [themeSwitched, setThemeSwitched] = useState(false);
  const [editorTheme, setEditorTheme] = useState(savedEditorTheme);
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

  const latest = useRef({ tabs, activeId, folder, git, panel, settings });
  latest.current = { tabs, activeId, folder, git, panel, settings };
  const active = tabs.find((t) => t.id === activeId) ?? null;

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
      else if (e.key === EDITOR_THEME_KEY && e.newValue) setEditorTheme(e.newValue);
      else if (e.key === TERMINAL_THEME_KEY && e.newValue) setTerminalTheme(e.newValue);
      else if (e.key === FONT_KEY && Number(e.newValue)) setFontSize(Number(e.newValue));
      else if (e.key === MEMES_KEY) setMemes(e.newValue !== "0");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => void api.pickerSetEnabled(settings.picker).catch(() => undefined), [settings.picker]);

  // Read by the patched xterm WebGL renderer (patches/@xterm__addon-webgl.patch).
  useEffect(() => void ((globalThis as { __lookoutBlinkMs?: number }).__lookoutBlinkMs = settings.blinkMs), [settings.blinkMs]);

  // The editor's syntax colors are CSS variables; set on the root they override styles.css.
  useEffect(() => {
    const { selection, ...syntax } = editorColors(editorTheme, theme);
    const style = document.documentElement.style;
    for (const [key, value] of Object.entries(syntax)) style.setProperty(`--syn-${key}`, value);
    if (selection) style.setProperty("--editor-selection", selection);
    else style.removeProperty("--editor-selection");
  }, [editorTheme, theme]);

  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontSize));
    document.documentElement.style.setProperty("--editor-font-size", `${fontSize}px`);
  }, [fontSize]);

  // ---- Tabs ----

  const addTab = useCallback((tab: Tab) => {
    setTabs((list) => {
      const at = list.findIndex((t) => t.id === latest.current.activeId);
      const next = [...list];
      next.splice(at < 0 ? next.length : at + 1, 0, tab);
      return next;
    });
    setActiveId(tab.id);
  }, []);

  const newTerminal = useCallback(
    (claude: boolean, cwd?: string) => {
      addTab({
        kind: "terminal",
        id: newId(),
        cwd: cwd ?? latest.current.folder,
        run: claude ? "claude" : null,
        sessionId: null,
        title: claude ? "claude" : "zsh",
        claude,
      });
    },
    [addTab],
  );

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
    setTabs((list) => {
      const index = list.findIndex((t) => t.id === id);
      const next = list.filter((t) => t.id !== id);
      if (latest.current.activeId === id) setActiveId(next[Math.min(index, next.length - 1)]?.id ?? null);
      return next;
    });
  }, []);

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
      // A single click replaces the previous preview tab, as in VS Code.
      const preview = list.find((t) => t.kind === "file" && t.preview && !t.dirty);
      if (!pin && preview) {
        setTabs((l) => l.map((t) => (t.id === preview.id ? tab : t)));
        setActiveId(tab.id);
        return;
      }
      addTab(tab);
    },
    [addTab],
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
      if (tab) closeTab(tab.id, true);
    });
    return () => void un.then((f) => f());
  }, [closeTab]);

  // ---- Notifications ----

  useEffect(() => {
    void api.notices().then(setNotices);
    const unList = appWindow.listen<Notice[]>("notices", (event) => setNotices(event.payload));
    const unPeek = appWindow.listen<Notice>("notice-peek", (event) => setPeeks((list) => [...list.slice(-2), event.payload]));
    // A notification was clicked in some window; the window with the tab shows it.
    const unOpen = appWindow.listen<string>("activate-tab", (event) => {
      if (!latest.current.tabs.some((t) => t.id === event.payload)) return;
      setActiveId(event.payload);
      void appWindow.unminimize().then(() => appWindow.setFocus());
    });
    return () => {
      void unList.then((f) => f());
      void unPeek.then((f) => f());
      void unOpen.then((f) => f());
    };
  }, []);

  const terminalEvent = async (tabId: string, event: TerminalEvent) => {
    const tab = latest.current.tabs.find((t) => t.id === tabId);
    if (tab?.kind !== "terminal") return;
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
        const title = claude ? "claude" : shell ? (info.cwd ? basename(info.cwd) : program) : program;
        if (title && (title !== tab.title || claude !== tab.claude)) {
          setTabs((l) => l.map((t) => (t.id === tab.id && t.kind === "terminal" ? { ...t, title, claude } : t)));
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
      setFolder(path);
      setGit(undefined);
      setQuickFiles(null);
      setRecent(await api.addRecentFolder(path));
      void api.watchFolder(path).catch((e) => toast("error", toAppError(e).message));
      void getCurrentWindow().setTitle(`Lookout - ${basename(path)}`);
      if (terminal && !latest.current.tabs.some((t) => t.kind === "terminal")) newTerminal(false, path);
    },
    [newTerminal, toast],
  );

  const chooseFolder = useCallback(async () => {
    const path = await openDialog({ directory: true, multiple: false });
    if (typeof path === "string") void openFolder(path);
  }, [openFolder]);

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

  /** The terminal to send to: the active one, or the most recent Claude terminal. */
  const targetTerminal = () => {
    const { tabs: list, activeId: current } = latest.current;
    const activeTab = list.find((t) => t.id === current);
    if (activeTab?.kind === "terminal") return activeTab;
    return list.find((t) => t.kind === "terminal" && t.claude) ?? list.find((t) => t.kind === "terminal") ?? null;
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
    setActiveId(tabId);
    setTimeout(() => terminal.focus(), at + 200);
  };

  const sendPick = (pick: Pick) => {
    const { tabs: list, activeId: current } = latest.current;
    const activeTab = list.find((t) => t.id === current);
    const claudeTab =
      activeTab?.kind === "terminal" && activeTab.claude ? activeTab : list.find((t) => t.kind === "terminal" && t.claude);
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
    setActiveId(tab.id);
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
      const tab = latest.current.tabs.find((t) => t.id === latest.current.activeId);
      if (!el?.closest(".terminal-view") || tab?.kind !== "terminal") return;
      const quoted = drop.paths.map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`));
      terminals.get(tab.id)?.paste(quoted.join(" ") + " ");
      terminals.get(tab.id)?.focus();
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
        moving = { ...tab, snapshot: await terminal.moveOut() };
      } else if (tab.kind === "file") {
        const editor = editors.get(tab.id);
        moving = { ...tab, preview: false, text: tab.dirty ? editor?.text() : undefined };
      }
      const start: WindowStart = { folder: current, tab: moving };
      await api.windowNew({ start, session, x: at?.x ?? null, y: at?.y ?? null });
    } catch (e) {
      terminal?.cancelMove();
      toast("error", toAppError(e).message);
      return;
    }
    // The tab lives on in the new window: no save prompt, and the terminal's shell keeps running.
    setTabs((l) => {
      const index = l.findIndex((t) => t.id === id);
      const next = l.filter((t) => t.id !== id);
      if (latest.current.activeId === id) setActiveId(next[Math.min(index, next.length - 1)]?.id ?? null);
      return next;
    });
  };

  const moveTab = (id: string, index: number) =>
    setTabs((l) => {
      const tab = l.find((t) => t.id === id);
      if (!tab) return l;
      const rest = l.filter((t) => t.id !== id);
      rest.splice(index, 0, tab);
      return rest;
    });

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
          for (const t of latest.current.tabs) if (t.id !== tab.id) closeTab(t.id);
        },
      },
    ];
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
      const { tabs: list, activeId: current } = latest.current;
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
      if (key === "n" && !e.shiftKey) return run(newWindow);
      if (key === "w" && e.shiftKey) return run(() => void getCurrentWindow().close());
      if (key === "w") return run(() => current && closeTab(current));
      if (key === "o") return run(() => void chooseFolder());
      if (key === "b") return run(() => setPanel((p) => (p ? null : "files")));
      if (key === "p" && latest.current.folder) return run(() => setQuickOpen(true));
      if (e.shiftKey && key === "e") return run(() => setPanel((p) => (p === "files" ? null : "files")));
      if (e.shiftKey && key === "f") return run(() => (setPanel("search"), setSearchToken((t) => t + 1)));
      if (e.shiftKey && (e.key === "[" || e.key === "{")) return run(() => go(-1));
      if (e.shiftKey && (e.key === "]" || e.key === "}")) return run(() => go(1));
      if (/^[1-9]$/.test(e.key)) return run(() => setActiveId((key === "9" ? list[list.length - 1] : list[Number(key) - 1])?.id ?? current));
      if (key === "=" || key === "+") return run(() => setFontSize((s) => Math.min(24, s + 1)));
      if (key === "-") return run(() => setFontSize((s) => Math.max(9, s - 1)));
      if (key === "0") return run(() => setFontSize(13));
      const tab = list.find((t) => t.id === current);
      if (tab?.kind === "terminal") {
        if (key === "k") return run(() => terminals.get(tab.id)?.clear());
        if (key === "f") return run(() => terminals.get(tab.id)?.find());
      }
      if (key === "r") e.preventDefault(); // ⌘R would reload the web view.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newTerminal, closeTab, chooseFolder, newWindow]);

  // Unsaved files are offered for saving before the window closes.
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested((event) => {
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

  // ---- Render ----

  const tabLabel = (tab: Tab) => {
    if (tab.kind === "terminal") return { icon: tab.claude ? <Sparkle size={13} className="claude-icon" /> : <SquareTerminal size={13} />, text: tab.title };
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
    const editorLabel = EDITOR_THEMES.find((t) => t.id === editorTheme)?.label;
    const terminalLabel = TERMINAL_THEMES.find((t) => t.id === terminalTheme)?.label;
    setMenu({
      x: rect.right + 6,
      y: rect.bottom,
      items: [
        {
          label: "Editor theme",
          icon: <Code size={14} />,
          detail: editorLabel,
          submenu: {
            title: "Editor theme",
            note: "Colors of code in files you open in the editor.",
            items: EDITOR_THEMES.map((t) => {
              const colors = editorColors(t.id, theme);
              return {
                label: t.label,
                icon: <ThemeSwatch colors={[colors.keyword, colors.string, colors.function]} />,
                detail: t.light ? undefined : "Dark mode only",
                checked: t.id === editorTheme,
                onSelect: () => {
                  setEditorTheme(t.id);
                  localStorage.setItem(EDITOR_THEME_KEY, t.id);
                },
              };
            }),
          },
        },
        {
          label: "Terminal theme",
          icon: <SquareTerminal size={14} />,
          detail: terminalLabel,
          submenu: {
            title: "Terminal theme",
            note: "Colors of text in terminal tabs: the prompt, commands, and program output.",
            items: TERMINAL_THEMES.map((t) => {
              const colors = terminalColors(t.id, theme);
              return {
                label: t.label,
                icon: <ThemeSwatch colors={[colors.red!, colors.green!, colors.blue!]} />,
                detail: t.light ? undefined : "Dark mode only",
                checked: t.id === terminalTheme,
                onSelect: () => {
                  setTerminalTheme(t.id);
                  localStorage.setItem(TERMINAL_THEME_KEY, t.id);
                },
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
            <Terminal size={15} strokeWidth={2.2} />
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
        <TabBar
          tabs={tabs}
          activeId={activeId}
          label={tabLabel}
          canTearOff={tabs.length > 1}
          onActivate={setActiveId}
          onClose={(id) => closeTab(id)}
          onPin={(id) => setTabs((l) => l.map((t) => (t.id === id && t.kind === "file" ? { ...t, preview: false } : t)))}
          onMenu={tabMenu}
          onMove={moveTab}
          onTearOff={(id, x, y) => void moveToNewWindow(id, { x, y })}
        >
          <button type="button" className="tab-new" title="New Terminal (⌘T)" onClick={() => newTerminal(false)}>
            <Plus size={15} />
          </button>
          <button type="button" className="tab-new claude" title="New Claude Session (⇧⌘T)" onClick={() => newTerminal(true)}>
            <Sparkle size={14} />
          </button>
        </TabBar>
        <div className="titlebar-actions">
          {git && <GitChip status={git} open={panel === "git"} onClick={() => setPanel((p) => (p === "git" ? null : "git"))} />}
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
          <NotificationBell notices={notices} onOpen={(n) => void api.noticeOpen(n.id)} />
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
          <button type="button" className="activity-button" data-tip="Settings" aria-label="Settings" onClick={settingsMenu}>
            <SidebarIcon name="settings" />
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
        </div>
      </nav>

      <aside className="side-panel">
        {panel && folder && (
          <>
            {panel === "files" && (
              <FilesPanel
                root={folder}
                marks={marks}
                activePath={active?.kind === "file" ? active.path : null}
                onOpen={(path, pin) => openFile(path, pin)}
                onMenu={fileMenu}
                onTrash={trashEntries}
                onMoved={filesMoved}
                onError={(m) => toast("error", m)}
              />
            )}
            {panel === "search" && (
              <SearchPanel root={folder} focusToken={searchToken} onOpen={(path, line, from, to) => openFile(path, false, { line, from, to })} />
            )}
            {panel === "git" && (
              <GitPanel
                status={git}
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
          </>
        )}
        {panel && !folder && (
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
        {tabs.map((tab) => {
          if (tab.kind === "terminal") {
            return (
              <TerminalView
                key={tab.id}
                tabId={tab.id}
                cwd={tab.cwd}
                run={tab.run}
                sessionId={tab.snapshot !== undefined ? tab.sessionId : null}
                snapshot={tab.snapshot}
                active={tab.id === activeId}
                theme={theme}
                terminalTheme={terminalTheme}
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
                active={tab.id === activeId}
                reveal={tab.reveal}
                text={tab.text}
                wordWrap={settings.wordWrap}
                onDirty={(dirty) =>
                  setTabs((l) => l.map((t) => (t.id === tab.id && t.kind === "file" ? { ...t, dirty, preview: dirty ? false : t.preview } : t)))
                }
                onSaved={() => void refreshGit()}
                onError={(m) => toast("error", m)}
              />
            );
          }
          return (
            <DiffView
              key={tab.id}
              root={tab.root}
              path={tab.path}
              staged={tab.staged}
              active={tab.id === activeId}
              version={dataVersion}
              onOpenFile={() => openFile(`${tab.root}/${tab.path}`, true)}
            />
          );
        })}
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
              <SquareTerminal size={36} strokeWidth={1.4} />
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
                  <Sparkle size={14} /> New Claude Session <span className="kbd">⇧⌘T</span>
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
function ThemeSwatch({ colors }: { colors: string[] }) {
  return (
    <span className="theme-swatch">
      {colors.map((c, i) => (
        <i key={i} style={{ background: c }} />
      ))}
    </span>
  );
}

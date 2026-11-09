import { Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type IBuffer, type IMarker } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, ChevronUp, X } from "./icons";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../api";
import { fontCss, KEY_REPEAT, type Settings } from "../lib/settings";
import { terminalColors } from "../lib/themes";
import type { Theme } from "../lib/theme";

/** What the rest of the app can do with a terminal. */
export interface TerminalHandle {
  /** Types text as if pasted, so programs like Claude Code treat it as one paste. */
  paste: (text: string) => void;
  /** Sends raw input to the program. */
  send: (data: string) => void;
  focus: () => void;
  clear: () => void;
  find: () => void;
  sessionId: () => string | null;
  /** Moves zsh to `path` when it waits at its prompt with nothing typed (see shell/zsh/lookout.zsh). */
  cd: (path: string) => void;
  /** Hands the session to another window: holds its output and returns the
   * screen and scrollback. Closing the tab afterwards leaves the shell running. */
  moveOut: () => Promise<string>;
  /** Takes the session back after a move failed. */
  cancelMove: () => void;
}

export const terminals = new Map<string, TerminalHandle>();

/** The JSON Claude Code passes to its hooks (see shell/claude-settings.json). */
export interface ClaudeHook {
  hook_event_name: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  message?: string;
  notification_type?: string;
  stop_hook_active?: boolean;
}

/** Something in the terminal worth a notification. */
export type TerminalEvent =
  | { type: "command"; line: string; exitCode: number; seconds: number }
  | { type: "claude"; hook: ClaudeHook }
  | { type: "message"; title: string; body: string }
  | { type: "title"; title: string };

/** Claude Code's prompt lines in its dark themes (promptBorder and
 * promptBorderShimmer), and the colors Lookout draws them in: half as bright. */
const DARK_BORDERS: Record<string, string> = { "136;136;136": "68;68;68", "166;166;166": "83;83;83" };

/** Draws Claude Code's prompt lines darker, by changing their color in the output. */
function darkenBorders(text: string): string {
  if (!text.includes("38;2;1")) return text;
  return text.replace(/\x1b\[[0-9;]*m/g, (seq) =>
    seq.replace(/([[;])38;2;(\d+;\d+;\d+)(?=[;m])/g, (all, lead: string, rgb: string) => (DARK_BORDERS[rgb] ? `${lead}38;2;${DARK_BORDERS[rgb]}` : all)),
  );
}

/** A range of cells to select and the text to copy for it. */
interface InputRange {
  col: number;
  row: number;
  length: number;
  text: string;
}

const isBlank = (chars: string) => chars === "" || chars === " ";

/** The last column of `row` with text, from `from` on, leaving out a box's right edge. -1 when there is none. */
function lastTextCol(buf: IBuffer, row: number, from: number, cols: number): number {
  const line = buf.getLine(row);
  if (!line) return -1;
  let edge = true;
  for (let x = cols - 1; x >= from; x--) {
    const cell = line.getCell(x);
    const chars = cell?.getChars() ?? "";
    if (isBlank(chars)) continue;
    if (edge && chars === "│") {
      edge = false;
      continue;
    }
    return x + Math.max(0, (cell?.getWidth() ?? 1) - 1);
  }
  return -1;
}

/** The first column of `row` after a box's left edge and spaces. */
function firstTextCol(buf: IBuffer, row: number, cols: number): number {
  const line = buf.getLine(row);
  let x = 0;
  while (x < cols && isBlank(line?.getCell(x)?.getChars() ?? "")) x++;
  if (line?.getCell(x)?.getChars() === "│") {
    x++;
    while (x < cols && isBlank(line?.getCell(x)?.getChars() ?? "")) x++;
  }
  return x;
}

/** The cells from (col, row) to (endCol, endRow) as a selection, with their
 * text: lines after the first lose the indent up to `col`. */
function rangeOf(buf: IBuffer, cols: number, col: number, row: number, endCol: number, endRow: number): InputRange {
  const lines: string[] = [];
  for (let y = row; y <= endRow; y++) {
    const line = buf.getLine(y);
    const from = y === row ? col : Math.min(col, firstTextCol(buf, y, cols));
    const to = y === endRow ? endCol + 1 : lastTextCol(buf, y, 0, cols) + 1;
    lines.push(to > from ? (line?.translateToString(true, from, to) ?? "") : "");
  }
  return { col, row, length: (endRow - row) * cols + (endCol + 1 - col), text: lines.join("\n") };
}

/** Claude Code's prompt: what is typed between the lines above and below it
 * (or inside its box, in older versions), near the bottom of the screen.
 * "empty" when nothing is typed, null when no prompt is on screen. */
function claudeInput(buf: IBuffer, cols: number, rows: number): InputRange | "empty" | null {
  const top = buf.baseY;
  const isRule = (y: number) => {
    const text = buf.getLine(y)?.translateToString(true).trim() ?? "";
    return text.length >= Math.min(20, cols / 2) && /^[╭╰]?─+[╮╯]?$/.test(text);
  };
  let below = -1;
  for (let y = top + rows - 1; y >= top && below < 0; y--) if (isRule(y)) below = y;
  let above = -1;
  for (let y = below - 1; y >= top && above < 0; y--) if (isRule(y)) above = y;
  if (above < 0 || below - above < 2) return null;
  const first = above + 1;
  const line = buf.getLine(first);
  let col = firstTextCol(buf, first, cols);
  const mark = line?.getCell(col)?.getChars();
  if (mark === ">" || mark === "❯") col += 1;
  while (col < cols && line?.getCell(col)?.getChars() === " ") col++;
  // The last line with text; a hint in dim text alone is no input.
  let endRow = -1;
  let endCol = -1;
  let typed = false;
  for (let y = below - 1; y >= first; y--) {
    const x = lastTextCol(buf, y, y === first ? col : 0, cols);
    if (x < 0) continue;
    if (endRow < 0) {
      endRow = y;
      endCol = x;
    }
    const row = buf.getLine(y);
    for (let c = y === first ? col : 0; c <= x && !typed; c++) {
      const cell = row?.getCell(c);
      if (cell && !isBlank(cell.getChars()) && !cell.isDim()) typed = true;
    }
  }
  if (endRow < 0 || !typed) return "empty";
  return rangeOf(buf, cols, col, first, endCol, endRow);
}

function decodeHook(base64: string): ClaudeHook | null {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

interface TerminalViewProps {
  tabId: string;
  cwd: string | null;
  /** A command typed into the shell once it starts, like "claude". */
  run: string | null;
  /** A running session to attach to, for a tab moved from another window. */
  sessionId: string | null;
  /** That tab's screen, drawn before the session's output continues. */
  snapshot?: string;
  active: boolean;
  theme: Theme;
  /** The color theme: an id from THEMES. */
  colorTheme: string;
  fontSize: number;
  settings: Settings;
  onSession: (sessionId: string) => void;
  onEvent: (event: TerminalEvent) => void;
  /** In a group of a split window, with its edges in `style`. */
  inSplit?: boolean;
  /** Takes the keyboard when shown. In a split window, only the tab in use does. */
  primary?: boolean;
  /** Text was copied from the terminal or pasted into it. */
  onClipboard?: (kind: "copied" | "pasted") => void;
  style?: CSSProperties;
}

export function TerminalView(props: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  /** Sends the terminal's size to the shell when it is not what the shell has. */
  const syncRef = useRef<(() => void) | null>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const findInput = useRef<HTMLInputElement>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const term = new Terminal({
      fontFamily: fontCss(props.settings.font),
      fontSize: props.fontSize,
      lineHeight: props.settings.lineHeight,
      cursorBlink: props.settings.cursorBlink,
      cursorStyle: props.settings.cursorStyle,
      scrollback: props.settings.scrollback,
      allowProposedApi: true,
      // By default Option types characters (@, $, [ and ] on many keyboards); word jumps are mapped below.
      macOptionIsMeta: props.settings.optionIsMeta,
      macOptionClickForcesSelection: true,
      // The background is transparent so the terminal shows the same color as the top bar.
      allowTransparency: true,
      theme: terminalColors(props.colorTheme, props.theme),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    const unicode = new Unicode11Addon();
    const serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(unicode);
    term.loadAddon(serialize);
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon((_event, uri) => void openUrl(uri)));
    term.open(containerRef.current!);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // Without WebGL xterm draws with the DOM renderer.
    }
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    const send = (data: string) => {
      if (sessionRef.current) void api.ptyWrite(sessionRef.current, data);
    };

    // Held ⌫, Delete, ← and → repeat at the speed from Settings instead of the macOS rate.
    let repeatTimer = 0;
    const stopRepeat = () => window.clearTimeout(repeatTimer);
    const repeatSequence = (e: KeyboardEvent): string | null => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return null;
      const app = term.modes.applicationCursorKeysMode;
      const plain: Record<string, string> = { Backspace: "\x7f", Delete: "\x1b[3~", ArrowLeft: app ? "\x1bOD" : "\x1b[D", ArrowRight: app ? "\x1bOC" : "\x1b[C" };
      const option: Record<string, string> = { Backspace: "\x17", ArrowLeft: "\x1bb", ArrowRight: "\x1bf" };
      return (e.altKey ? option[e.key] : plain[e.key]) ?? null;
    };
    containerRef.current!.addEventListener("focusout", stopRepeat);

    term.attachCustomKeyEventHandler((e) => {
      const repeat = KEY_REPEAT[latest.current.settings.keyRepeat];
      const sequence = repeat.interval ? repeatSequence(e) : null;
      if (e.type === "keyup") {
        if (sequence !== null || ["Backspace", "Delete", "ArrowLeft", "ArrowRight"].includes(e.key)) stopRepeat();
        return true;
      }
      if (e.type !== "keydown") return true;
      if (sequence !== null) {
        if (!e.repeat) {
          stopRepeat();
          send(sequence);
          const tick = () => {
            send(sequence);
            repeatTimer = window.setTimeout(tick, repeat.interval);
          };
          repeatTimer = window.setTimeout(tick, repeat.delay);
        }
        return false;
      }
      stopRepeat();
      // Shift+Return is a new line in Claude Code's prompt (what its /terminal-setup configures).
      if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey) {
        send("\x1b\r");
        return false;
      }
      if (e.metaKey) {
        // ⌘A selects what is typed at the prompt, not the whole screen.
        if (e.key === "a" && !e.altKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          selectInput();
          return false;
        }
        // ⌘Z undoes the last change at the prompt, a paste as a whole: Ctrl+_ is undo in zsh and in Claude Code.
        if (e.key.toLowerCase() === "z" && !e.altKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          send("\x1f");
          return false;
        }
        const map: Record<string, string> = { ArrowLeft: "\x01", ArrowRight: "\x05", Backspace: "\x15" };
        // ⌥⌘ and an arrow moves between the panes of a split.
        if (map[e.key] && !e.altKey) {
          send(map[e.key]);
          return false;
        }
        // Other ⌘ shortcuts belong to the app (copy and paste come through the Edit menu).
        return false;
      }
      if (e.altKey && !e.ctrlKey) {
        const map: Record<string, string> = { ArrowLeft: "\x1bb", ArrowRight: "\x1bf", Backspace: "\x17" };
        if (map[e.key]) {
          send(map[e.key]);
          return false;
        }
      }
      return true;
    });

    // Lookout's marks, OSC 7701 (see shell/zsh/lookout.zsh): a command
    // starting and ending, and the path of a file with a Claude Code hook's JSON.
    let command: { line: string; at: number } | null = null;
    /** Where zsh started reading the command line (OSC 7701 "input"), until the command runs. */
    let input: { mark: IMarker; col: number } | null = null;
    let hooks: Promise<void> = Promise.resolve();
    term.parser.registerOscHandler(7701, (data) => {
      const [kind, ...rest] = data.split(";");
      const value = rest.join(";");
      if (kind === "input") {
        input?.mark.dispose();
        const mark = term.registerMarker(0);
        input = mark ? { mark, col: term.buffer.active.cursorX } : null;
      } else if (kind === "start") {
        input?.mark.dispose();
        input = null;
        command = { line: value, at: Date.now() };
      } else if (kind === "end" && command) {
        latest.current.onEvent({ type: "command", line: command.line, exitCode: Number(value) || 0, seconds: (Date.now() - command.at) / 1000 });
        command = null;
      } else if (kind === "claude-file") {
        // One at a time, so the events keep their order.
        hooks = hooks
          .then(() => api.claudeHook(value))
          .then((hook) => {
            if (hook && typeof hook.hook_event_name === "string") latest.current.onEvent({ type: "claude", hook: hook as unknown as ClaudeHook });
          })
          .catch(() => undefined);
      } else if (kind === "claude") {
        // Claude sessions started before the hooks moved to files.
        const hook = decodeHook(value);
        if (hook) latest.current.onEvent({ type: "claude", hook });
      }
      return true;
    });
    // The window title a program sets, OSC 0 or 2.
    term.onTitleChange((title) => latest.current.onEvent({ type: "title", title }));
    // Notifications programs send to the terminal: OSC 9 as in iTerm2, and
    // OSC 777 "notify;title;body" as in rxvt and Ghostty.
    term.parser.registerOscHandler(9, (data) => {
      // Numbered OSC 9 commands, like ConEmu's progress, are not messages.
      if (/^\d+;/.test(data)) return false;
      latest.current.onEvent({ type: "message", title: "", body: data });
      return true;
    });
    term.parser.registerOscHandler(777, (data) => {
      const [kind, title = "", ...body] = data.split(";");
      if (kind !== "notify") return false;
      latest.current.onEvent({ type: "message", title, body: body.join(";") });
      return true;
    });

    /** The command line zsh is reading: from where it started to the last typed character. */
    const shellInput = (): InputRange | "empty" | null => {
      const buf = term.buffer.active;
      if (!input || input.mark.isDisposed || input.mark.line < 0 || buf.type !== "normal") return null;
      const row = input.mark.line;
      let last = Math.max(row, buf.baseY + buf.cursorY);
      while (buf.getLine(last + 1)?.isWrapped) last++;
      for (let y = last; y >= row; y--) {
        const x = lastTextCol(buf, y, y === row ? input.col : 0, term.cols);
        if (x >= 0) return rangeOf(buf, term.cols, input.col, row, x, y);
      }
      return "empty";
    };

    /** The selection ⌘A made and the text to copy for it, while it is selected. */
    let selected: { key: string; text: string } | null = null;
    let selecting = false;
    const selectionKey = () => {
      const p = term.getSelectionPosition();
      return p ? `${p.start.x},${p.start.y},${p.end.x},${p.end.y}` : "";
    };
    /** Selects what is typed: at the shell's prompt, or in Claude Code's. Anything else selects all. */
    const selectInput = () => {
      const buf = term.buffer.active;
      const range = (command ? null : shellInput()) ?? claudeInput(buf, term.cols, term.rows);
      selected = null;
      if (range === "empty") return term.clearSelection();
      if (!range) return term.selectAll();
      selecting = true;
      term.select(range.col, range.row, range.length);
      selecting = false;
      selected = { key: selectionKey(), text: range.text };
      if (latest.current.settings.copyOnSelect) void api.copyText(range.text);
    };
    /** The text a copy takes: the typed text after ⌘A, else what is selected. */
    const selectionText = () => (selected && selected.key === selectionKey() ? selected.text : term.getSelection());

    // Copy from the Edit menu or ⌘C; xterm's own handler copies the selection as it is on screen.
    containerRef.current!.addEventListener(
      "copy",
      (e) => {
        if (!term.hasSelection()) return;
        e.clipboardData?.setData("text/plain", selectionText());
        e.preventDefault();
        e.stopImmediatePropagation();
        latest.current.onClipboard?.("copied");
      },
      true,
    );
    containerRef.current!.addEventListener("paste", () => latest.current.onClipboard?.("pasted"), true);

    const channel = new Channel<ArrayBuffer>();
    // Output is decoded here, so Claude Code's prompt lines can be drawn darker in dark mode.
    const decoder = new TextDecoder();
    // A color code cut off at the end of a chunk waits for the rest, or for a moment.
    let held = "";
    let heldTimer = 0;
    const flush = () => {
      if (held) term.write(held);
      held = "";
    };
    channel.onmessage = (data) => {
      window.clearTimeout(heldTimer);
      let text = held + decoder.decode(new Uint8Array(data), { stream: true });
      held = "";
      if (latest.current.theme === "dark") {
        const cut = /\x1b(\[[0-9;]*)?$/.exec(text);
        if (cut) {
          held = text.slice(cut.index);
          text = text.slice(0, cut.index);
          heldTimer = window.setTimeout(flush, 30);
        }
        text = darkenBorders(text);
      }
      if (text) term.write(text);
    };
    term.onData(send);
    // Show the scrollbar while the user scrolls, then let it fade out.
    let scrollTimer = 0;
    const view = containerRef.current!.closest(".terminal-view");
    containerRef.current!.addEventListener(
      "wheel",
      () => {
        view?.classList.add("scrolling");
        window.clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(() => view?.classList.remove("scrolling"), 1000);
      },
      { passive: true },
    );
    term.onSelectionChange(() => {
      if (selecting) return;
      if (selected && selected.key !== selectionKey()) selected = null;
      if (latest.current.settings.copyOnSelect && term.hasSelection()) {
        void api.copyText(selectionText());
        latest.current.onClipboard?.("copied");
      }
    });
    term.onBinary((data) => send(data));
    // The shell is told the terminal's size whenever it changes. A resize while
    // the shell is still starting is sent once it runs: otherwise the shell
    // keeps the old width and Claude Code draws its lines too long, so they
    // spill onto the next row, until the window is resized.
    let sent = { cols: 0, rows: 0 };
    const syncSize = () => {
      const id = sessionRef.current;
      if (!id || (sent.cols === term.cols && sent.rows === term.rows)) return;
      sent = { cols: term.cols, rows: term.rows };
      void api.ptyResize(id, term.cols, term.rows);
    };
    syncRef.current = syncSize;
    term.onResize(syncSize);

    let disposed = false;
    /** The session moved to another window and must keep running. */
    let released = false;
    if (props.sessionId) {
      // A tab from another window: its screen, then the output held since it left.
      const id = props.sessionId;
      if (props.snapshot) term.write(props.snapshot);
      sessionRef.current = id;
      void api.ptyAttach(id, channel).then(
        () => {
          // The window may have another size; programs redraw for the new one.
          sent = { cols: term.cols, rows: term.rows };
          void api.ptyResize(id, term.cols, term.rows);
          props.onSession(id);
        },
        (e) => term.write(`\r\n\x1b[31mCould not move the terminal: ${String(e?.message ?? e)}\x1b[0m\r\n`),
      );
    } else {
      sent = { cols: term.cols, rows: term.rows };
      void api.ptySpawn(props.cwd, term.cols, term.rows, props.run, props.settings.lastLogin, channel).then(
        (id) => {
          if (disposed) {
            void api.ptyKill(id);
            return;
          }
          sessionRef.current = id;
          syncSize();
          props.onSession(id);
        },
        (e) => term.write(`\r\n\x1b[31mCould not start the shell: ${String(e?.message ?? e)}\x1b[0m\r\n`),
      );
    }

    const handle: TerminalHandle = {
      paste: (text) => term.paste(text),
      send,
      focus: () => term.focus(),
      clear: () => term.clear(),
      find: () => {
        setFinding(true);
        requestAnimationFrame(() => findInput.current?.select());
      },
      sessionId: () => sessionRef.current,
      cd: (path) => {
        // Only at zsh's prompt: no program runs. zsh itself checks that nothing is typed.
        if (command || !input || input.mark.isDisposed || term.buffer.active.type !== "normal") return;
        send(`\x1b[7701~${path}\x1b[201~`);
      },
      moveOut: async () => {
        const id = sessionRef.current;
        if (!id) throw new Error("The terminal is still starting");
        await api.ptyDetach(id);
        // Output already sent over the channel arrives before the screen is copied.
        await new Promise((resolve) => setTimeout(resolve, 80));
        released = true;
        return serialize.serialize({ scrollback: latest.current.settings.scrollback });
      },
      cancelMove: () => {
        released = false;
        if (sessionRef.current) void api.ptyAttach(sessionRef.current, channel);
      },
    };
    terminals.set(props.tabId, handle);

    // Fit once the size settles: fitting on every frame of the side panel's
    // animation redraws the screen and resizes the shell each time, which flashes.
    let fitTimer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        if (containerRef.current?.offsetParent) fit.fit();
      }, 90);
    });
    observer.observe(containerRef.current!);

    return () => {
      disposed = true;
      window.clearTimeout(fitTimer);
      window.clearTimeout(heldTimer);
      observer.disconnect();
      terminals.delete(props.tabId);
      const id = sessionRef.current;
      // React mounts twice in development; a tab that mounted again keeps its session.
      if (id && !released) setTimeout(() => terminals.has(props.tabId) || void api.ptyKill(id), 0);
      term.dispose();
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = terminalColors(props.colorTheme, props.theme);
  }, [props.theme, props.colorTheme]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = props.fontSize;
    fitRef.current?.fit();
  }, [props.fontSize]);

  const { cursorStyle, cursorBlink, font, lineHeight, optionIsMeta, scrollback } = props.settings;
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.cursorStyle = cursorStyle;
    term.options.cursorBlink = cursorBlink;
    term.options.macOptionIsMeta = optionIsMeta;
    term.options.scrollback = scrollback;
    if (term.options.fontFamily !== fontCss(font) || term.options.lineHeight !== lineHeight) {
      term.options.fontFamily = fontCss(font);
      term.options.lineHeight = lineHeight;
      fitRef.current?.fit();
    }
  }, [cursorStyle, cursorBlink, font, lineHeight, optionIsMeta, scrollback]);

  const primary = props.primary ?? true;
  useEffect(() => {
    if (!props.active) return;
    // A hidden terminal has no size; it is measured again when shown.
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      syncRef.current?.();
      if (primary) termRef.current?.focus();
    });
  }, [props.active, primary]);

  const findStep = (next: boolean) => {
    if (!query) return;
    const options = { decorations: { matchOverviewRuler: "#888", activeMatchColorOverviewRuler: "#fff", activeMatchBackground: "#e0af68", matchBackground: "#e0af6855" } };
    if (next) searchRef.current?.findNext(query, options);
    else searchRef.current?.findPrevious(query, options);
  };

  return (
    <div className={`terminal-view${props.active ? "" : " hidden"}${props.inSplit ? " in-split" : ""}`} style={props.style} data-tab={props.tabId}>
      {finding && (
        <div className="term-find">
          <input
            ref={findInput}
            value={query}
            placeholder="Find"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                findStep(!e.shiftKey);
              } else if (e.key === "Escape") {
                setFinding(false);
                searchRef.current?.clearDecorations();
                termRef.current?.focus();
              }
            }}
          />
          <button type="button" className="icon-button" title="Previous" onClick={() => findStep(false)}>
            <ChevronUp size={14} />
          </button>
          <button type="button" className="icon-button" title="Next" onClick={() => findStep(true)}>
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Close"
            onClick={() => {
              setFinding(false);
              searchRef.current?.clearDecorations();
              termRef.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div ref={containerRef} className="terminal-host" />
    </div>
  );
}

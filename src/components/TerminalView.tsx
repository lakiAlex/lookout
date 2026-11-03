import { Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, ChevronUp, X } from "./icons";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { fontCss, KEY_REPEAT, type Settings } from "../lib/settings";
import { terminalColors } from "../lib/terminalThemes";
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
  /** Hands the session to another window: holds its output and returns the
   * screen and scrollback. Closing the tab afterwards leaves the shell running. */
  moveOut: () => Promise<string>;
  /** Takes the session back after a move failed. */
  cancelMove: () => void;
}

export const terminals = new Map<string, TerminalHandle>();

/** The JSON Claude Code passes to its Stop and Notification hooks. */
export interface ClaudeHook {
  hook_event_name: string;
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
  /** An id from TERMINAL_THEMES. */
  terminalTheme: string;
  fontSize: number;
  settings: Settings;
  onSession: (sessionId: string) => void;
  onEvent: (event: TerminalEvent) => void;
}

export function TerminalView(props: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
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
      theme: terminalColors(props.terminalTheme, props.theme),
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
        const map: Record<string, string> = { ArrowLeft: "\x01", ArrowRight: "\x05", Backspace: "\x15" };
        if (map[e.key]) {
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
    // starting and ending, and the JSON of Claude Code's hooks.
    let command: { line: string; at: number } | null = null;
    term.parser.registerOscHandler(7701, (data) => {
      const [kind, ...rest] = data.split(";");
      const value = rest.join(";");
      if (kind === "start") {
        command = { line: value, at: Date.now() };
      } else if (kind === "end" && command) {
        latest.current.onEvent({ type: "command", line: command.line, exitCode: Number(value) || 0, seconds: (Date.now() - command.at) / 1000 });
        command = null;
      } else if (kind === "claude") {
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

    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (data) => term.write(new Uint8Array(data));
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
      if (latest.current.settings.copyOnSelect && term.hasSelection()) void api.copyText(term.getSelection());
    });
    term.onBinary((data) => send(data));
    term.onResize(({ cols, rows }) => {
      if (sessionRef.current) void api.ptyResize(sessionRef.current, cols, rows);
    });

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
          void api.ptyResize(id, term.cols, term.rows);
          props.onSession(id);
        },
        (e) => term.write(`\r\n\x1b[31mCould not move the terminal: ${String(e?.message ?? e)}\x1b[0m\r\n`),
      );
    } else {
      void api.ptySpawn(props.cwd, term.cols, term.rows, props.run, props.settings.lastLogin, channel).then(
        (id) => {
          if (disposed) {
            void api.ptyKill(id);
            return;
          }
          sessionRef.current = id;
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

    const observer = new ResizeObserver(() => {
      if (containerRef.current?.offsetParent) fit.fit();
    });
    observer.observe(containerRef.current!);

    return () => {
      disposed = true;
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
    term.options.theme = terminalColors(props.terminalTheme, props.theme);
  }, [props.theme, props.terminalTheme]);

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

  useEffect(() => {
    if (!props.active) return;
    // A hidden terminal has no size; it is measured again when shown.
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    });
  }, [props.active]);

  const findStep = (next: boolean) => {
    if (!query) return;
    const options = { decorations: { matchOverviewRuler: "#888", activeMatchColorOverviewRuler: "#fff", activeMatchBackground: "#e0af68", matchBackground: "#e0af6855" } };
    if (next) searchRef.current?.findNext(query, options);
    else searchRef.current?.findPrevious(query, options);
  };

  return (
    <div className={`terminal-view${props.active ? "" : " hidden"}`}>
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

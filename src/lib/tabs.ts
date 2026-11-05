import { getCurrentWindow } from "@tauri-apps/api/window";

export type Reveal = { line: number; from?: number; to?: number };

export type ClaudeState = "working" | "done" | "waiting";

/** Every tab is in a group: a part of the window with its own tabs. A window
 * that is not split has one group. */
type InGroup = { group?: string };

export type Tab = InGroup &
  (
    | {
        kind: "terminal";
        id: string;
        cwd: string | null;
        run: string | null;
        sessionId: string | null;
        title: string;
        claude: boolean;
        /** The title the program in front set (OSC 0 or 2). Claude Code sets it to the topic. */
        termTitle?: string;
        /** The Claude session's name, from its transcript. */
        sessionName?: string;
        /** The Claude Code session id running here, from its hooks; for resuming. */
        claudeSession?: string;
        /** The folder that Claude session runs in, from its hooks. */
        claudeCwd?: string;
        /** What Claude is doing, for the dot on the tab. Done and waiting clear once the tab is seen. */
        claudeState?: ClaudeState;
        /** Tokens and cost of the Claude session so far. */
        usage?: { tokens: number; cost: number | null };
        /** The screen of a terminal moved from another window, drawn before its session attaches. */
        snapshot?: string;
      }
    | {
        kind: "file";
        id: string;
        path: string;
        dirty: boolean;
        preview: boolean;
        reveal: Reveal | null;
        /** Unsaved text of a file moved from another window. */
        text?: string;
      }
    | { kind: "diff"; id: string; root: string; path: string; staged: boolean }
  );

/** What a new window opens with, from window_start. */
export interface WindowStart {
  folder: string | null;
  tab: Tab | null;
}

// Ids start with the window's label, so tabs that move between windows stay unique.
const label = getCurrentWindow().label;
let nextId = 1;
export const newTabId = () => `${label}:tab${nextId++}`;
let nextGroup = 1;
export const newGroupId = () => `${label}:group${nextGroup++}`;

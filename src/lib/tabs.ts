import { getCurrentWindow } from "@tauri-apps/api/window";

export type Reveal = { line: number; from?: number; to?: number };

export type Tab =
  | {
      kind: "terminal";
      id: string;
      cwd: string | null;
      run: string | null;
      sessionId: string | null;
      title: string;
      claude: boolean;
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
  | { kind: "diff"; id: string; root: string; path: string; staged: boolean };

/** What a new window opens with, from window_start. */
export interface WindowStart {
  folder: string | null;
  tab: Tab | null;
}

// Ids start with the window's label, so tabs that move between windows stay unique.
const label = getCurrentWindow().label;
let nextId = 1;
export const newTabId = () => `${label}:tab${nextId++}`;

import { Channel, invoke } from "@tauri-apps/api/core";

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  ignored: boolean;
}

export interface FileText {
  text: string;
  binary: boolean;
  tooLarge: boolean;
}

export interface SessionInfo {
  cwd: string | null;
  process: string | null;
}

export interface SearchOptions {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string;
  exclude: string;
}

export interface LineMatch {
  line: number;
  text: string;
  ranges: [number, number][];
}

export interface FileMatches {
  path: string;
  rel: string;
  matches: LineMatch[];
}

export interface SearchResult {
  files: FileMatches[];
  total: number;
  truncated: boolean;
  cancelled: boolean;
}

export interface GitFile {
  path: string;
  /** git's status letters for the index and the working tree; "." is unchanged. */
  index: string;
  work: string;
  from: string | null;
}

export interface GitStatus {
  root: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  /** Lines added and removed since the last commit, new files included. */
  added: number;
  removed: number;
}

/** A notification under the bell in the title bar. */
export interface Notice {
  id: number;
  kind: NoticeKind;
  title: string;
  body: string;
  tabId: string;
  tabTitle: string;
  /** Milliseconds since 1970. */
  time: number;
  read: boolean;
}

export type NoticeKind = "claude" | "claude-input" | "done" | "failed" | "message";

export interface NewNotice {
  kind: NoticeKind;
  title: string;
  body: string;
  tabId: string;
  tabTitle: string;
  /** The tab is the one showing in its window. */
  tabActive: boolean;
  /** macOS notifications are on in Settings. */
  banner: boolean;
}

/** Opens a window. `start` is handed to its page as it is. */
export interface NewWindow {
  start: unknown;
  /** The terminal session of a tab moved to the window. */
  session: string | null;
  /** Where a dragged tab was dropped, in screen points. */
  x: number | null;
  y: number | null;
}

export interface Branches {
  current: string | null;
  local: string[];
  remote: string[];
}

/** An element picked on screen. */
export interface Pick {
  id: string;
  label: string;
  app: string;
  report: string;
  image: string | null;
  frame: { x: number; y: number; width: number; height: number };
  bundleId: string | null;
}

export interface AppError {
  code: string;
  message: string;
}

export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "code" in e && "message" in e) return e as AppError;
  return { code: "error", message: String(e) };
}

export const api = {
  pickerStart: () => invoke<void>("picker_start"),
  pickerCancel: () => invoke<void>("picker_cancel"),
  pickerSetEnabled: (enabled: boolean) => invoke<void>("picker_set_enabled", { enabled }),
  pickerPermission: () => invoke<boolean>("picker_permission"),
  openAccessibilitySettings: () => invoke<void>("open_accessibility_settings"),
  copyText: (text: string) => invoke<void>("copy_text", { text }),
  ptySpawn: (cwd: string | null, cols: number, rows: number, run: string | null, login: boolean, onData: Channel<ArrayBuffer>) =>
    invoke<string>("pty_spawn", { cwd, cols, rows, run, login, onData }),
  ptyDetach: (id: string) => invoke<void>("pty_detach", { id }),
  ptyAttach: (id: string, onData: Channel<ArrayBuffer>) => invoke<void>("pty_attach", { id, onData }),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: string) => invoke<void>("pty_kill", { id }),
  ptyInfo: (id: string) => invoke<SessionInfo>("pty_info", { id }),

  listDir: (path: string) => invoke<Entry[]>("list_dir", { path }),
  listFiles: (root: string) => invoke<string[]>("list_files", { root }),
  readFile: (path: string) => invoke<FileText>("read_file", { path }),
  writeFile: (path: string, text: string) => invoke<void>("write_file", { path, text }),
  createPath: (path: string, dir: boolean) => invoke<void>("create_path", { path, dir }),
  renamePath: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  trashPaths: (paths: string[]) => invoke<void>("trash_paths", { paths }),
  /** Copies into `dir`; taken names get a number. Returns the new paths. */
  copyPaths: (paths: string[], dir: string) => invoke<string[]>("copy_paths", { paths, dir }),
  /** Moves into `dir`. Returns [old, new] for each item that moved. */
  movePaths: (paths: string[], dir: string) => invoke<[string, string][]>("move_paths", { paths, dir }),
  watchFolder: (path: string) => invoke<void>("watch_folder", { path }),
  homeDir: () => invoke<string>("home_dir"),
  recentFolders: () => invoke<string[]>("recent_folders"),
  addRecentFolder: (path: string) => invoke<string[]>("add_recent_folder", { path }),

  search: (root: string, options: SearchOptions) => invoke<SearchResult>("search_files", { root, options }),

  gitStatus: (path: string) => invoke<GitStatus | null>("git_status", { path }),
  gitStage: (root: string, paths: string[]) => invoke<void>("git_stage", { root, paths }),
  gitUnstage: (root: string, paths: string[]) => invoke<void>("git_unstage", { root, paths }),
  gitDiscard: (root: string, tracked: string[], untracked: string[]) => invoke<void>("git_discard", { root, tracked, untracked }),
  gitCommit: (root: string, message: string, amend: boolean) => invoke<string>("git_commit", { root, message, amend }),
  gitPush: (root: string) => invoke<string>("git_push", { root }),
  gitPull: (root: string) => invoke<string>("git_pull", { root }),
  gitFetch: (root: string) => invoke<void>("git_fetch", { root }),
  gitBranches: (root: string) => invoke<Branches>("git_branches", { root }),
  gitSwitch: (root: string, branch: string, create: boolean) => invoke<void>("git_switch", { root, branch, create }),
  gitShow: (root: string, rev: string, path: string) => invoke<string>("git_show", { root, rev, path }),

  windowNew: (request: NewWindow) => invoke<string>("window_new", { request }),
  windowStart: () => invoke<unknown>("window_start"),

  noticePost: (notice: NewNotice) => invoke<void>("notice_post", { notice }),
  notices: () => invoke<Notice[]>("notices_list"),
  noticesRead: () => invoke<void>("notices_read"),
  noticeRemove: (id: number) => invoke<void>("notice_remove", { id }),
  noticesClear: () => invoke<void>("notices_clear"),
  noticeOpen: (id: number) => invoke<void>("notice_open", { id }),
  claudeReply: (transcript: string) => invoke<string | null>("claude_reply", { transcript }),
  claudeTitle: (transcript: string) => invoke<string | null>("claude_title", { transcript }),
  claudeSessions: () => invoke<ClaudeSession[]>("claude_sessions"),
  claudeSessionDelete: (id: string) => invoke<void>("claude_session_delete", { id }),
  /** By session id, or by transcript path. */
  claudeSessionDetails: (id: string) => invoke<SessionDetails | null>("claude_session_details", { id }),
  claudeSessionRename: (id: string, name: string) => invoke<void>("claude_session_rename", { id, name }),
  listeningPorts: () => invoke<ListeningPort[]>("listening_ports"),
};

/** A past Claude Code session, for the history panel. */
export interface ClaudeSession {
  id: string;
  cwd: string;
  title: string | null;
  prompt: string | null;
  branch: string | null;
  /** Milliseconds since 1970. */
  modified: number;
}

/** Read from a session's whole transcript, for its details and usage. */
export interface SessionDetails {
  /** Messages typed and Claude's replies, without tool calls. */
  messages: number;
  branch: string | null;
  lastReply: string | null;
  tokens: number;
  /** In US dollars, as Claude Code counted it. */
  cost: number | null;
}

/** A local server running in one of the terminals. */
export interface ListeningPort {
  port: number;
  pid: number;
  process: string;
  sessionId: string;
}

export function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

export function dirname(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function relative(root: string, path: string): string {
  return path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

/** "/Users/x/Projects/a" -> "~/Projects/a" */
export function tildify(path: string, home: string): string {
  return home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

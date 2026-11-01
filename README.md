# Lookout

Lookout is a terminal for macOS for working with Claude Code. It has a file explorer, search, source control and an editor in a sidebar like VS Code, and a picker that sends any element on screen, in any app, to Claude.

![Lookout in use: an element picked in Chrome is pasted into Claude Code, Claude answers and edits the code, then the Files and Source Control panels, light mode and the settings menu](docs/demo.gif)

It is built with [Tauri 2](https://tauri.app): a Rust backend for the shell sessions, files, search, git and the macOS Accessibility calls behind the picker, and a React frontend with [xterm.js](https://xtermjs.org) for the terminal and [CodeMirror](https://codemirror.net) for the editor. The app is about 18 MB, 7.5 MB as a download.

## Features

**Terminal**

- Tabs with your login shell, started in the open folder. ⌘T opens a terminal, ⇧⌘T (or the Claude button in the tab bar) opens a terminal that runs `claude`.
- Tab titles follow the running program, and tabs running Claude Code get the Claude icon.
- GPU rendering, clickable links, find (⌘F) and clear (⌘K).
- Keys set up for Claude Code: Shift+Return is a new line in the prompt, ⌘← and ⌘→ go to the start and end of the line, ⌘⌫ deletes the line, ⌥← and ⌥→ move by word, ⌥⌫ deletes a word.
- For zsh, Lookout loads your own `.zshenv`, `.zprofile`, `.zshrc` and `.zlogin` and then adds what is missing: a colored prompt with the folder and git branch when you use the macOS default prompt, command highlighting with zsh-syntax-highlighting when you do not load it yourself, and colored `ls` output. This only applies inside Lookout.

**Element picker**

- Press ⌥⌘E anywhere, or click the picker icon in the sidebar, then point at something in any app and click. Up and Down select the parent or child element, Return picks, Esc or a right-click cancels.
- Lookout reads the element through macOS Accessibility: the app and window, the page address and title in browsers, the element's role, name, value and text, its DOM id and classes in Chromium and Electron apps, its position, the elements around it, and a screenshot of it.
- The report and screenshot are pasted into the Claude tab, followed by a space, so you can type your question right after. When no Claude tab is open, a new Claude session starts and gets the pick.
- Recent picks stay as chips under the terminal. Click one to send it again.

**Files**

- An explorer like VS Code's, with file icons, git status colors, dimmed ignored files and live updates when files change on disk.
- New file, new folder, rename, move to Trash, reveal in Finder, copy path or relative path, open a terminal in a folder, and Mention in Claude, which types `@path` into the Claude tab.
- Quick open with ⌘P.

**Search**

- Search the folder with ripgrep's engine: match case, whole word, regular expressions, and files to include or exclude. `.gitignore` is respected. Click a result to open the file at that line.

**Source control**

- Staged and unstaged changes, stage, unstage or discard one file or all, side-by-side diffs, commit with ⌘Return, push, pull, fetch, and switch or create branches.
- Uses the `git` installed on the Mac, with your config and credentials.

**Editor**

- Files open in tabs with syntax highlighting for most languages, find and replace, multiple cursors, bracket matching, folding and ⌘S to save.
- A single click opens a preview tab that the next single click replaces, as in VS Code. A double click or an edit keeps the tab.

**Settings**

- Light and dark mode in the top bar.
- The gear at the bottom of the sidebar has: editor theme and terminal theme (15 popular VS Code themes, One Dark Pro by default), font (SF Mono, Menlo, Monaco and installed coding fonts such as JetBrains Mono or Fira Code), font size, line spacing, terminal cursor (underline, bar or block, blinking or not, and how fast it blinks), key repeat for ⌫, Delete, ← and → (fast by default, or the macOS setting), the Option key as Meta, copy on select, scrollback length, the element picker on or off, word wrap in the editor, and memes.
- The sidebar minimizes to a narrow strip with small icons.
- The dog button in the corner shows a random meme from Reddit through [meme-api.com](https://github.com/D3vd/Meme_Api), skipping posts marked NSFW. Settings > Memes turns it off.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| ⌥⌘E | Pick an element on screen (works in any app) |
| ⌘T, ⇧⌘T | New terminal, new Claude session |
| ⌘W | Close tab |
| ⌘1 to ⌘9, ⇧⌘[ and ⇧⌘], ⌃Tab | Switch tabs |
| ⌘O | Open folder |
| ⌘P | Quick open a file |
| ⌘B | Show or hide the sidebar panel |
| ⇧⌘E, ⇧⌘F, ⌃⇧G | Files, search, source control |
| ⌘F, ⌘K | Find in terminal, clear terminal |
| ⌘S | Save file |
| ⌘=, ⌘-, ⌘0 | Bigger, smaller, default font size |

## Install

Download `Lookout_<version>_aarch64.dmg` from [Releases](../../releases), open it, and drag `Lookout` into the Applications folder. The build is for Apple Silicon Macs and needs macOS 11 or later. A `.app.zip` is attached too.

The app is not signed with an Apple Developer certificate or notarized, so the first time you open it macOS says it cannot be verified. Either right-click the app and choose Open, then confirm once, or run:

```sh
xattr -dr com.apple.quarantine /Applications/Lookout.app
```

The picker needs two permissions, which Lookout asks for the first time you pick:

- Accessibility, to read elements in other apps. System Settings, Privacy & Security, Accessibility, switch Lookout on.
- Screen Recording, for the screenshot of the picked element. System Settings, Privacy & Security, Screen & System Audio Recording, switch Lookout on, then quit and reopen Lookout. Without it, picks are sent without a screenshot.

## Build from source

Requirements: [Rust](https://rustup.rs) (stable), Node.js 20 or later, and [pnpm](https://pnpm.io).

```sh
pnpm install
pnpm tauri dev           # run in development mode
scripts/install.sh       # build Lookout.app and install it in /Applications
```

`scripts/install.sh` signs the app with a requirement on its bundle id instead of the build, so macOS keeps the Accessibility permission across rebuilds. When Lookout runs through `pnpm tauri dev`, macOS gives the permission to the terminal that started it instead.

## Tests

```sh
cd src-tauri
cargo test
```

## Project layout

| Path | Contents |
| --- | --- |
| `src-tauri/src/picker.rs` | The element picker: event tap, Accessibility lookups, highlight window, report and screenshot |
| `src-tauri/src/pty.rs` | Shell sessions |
| `src-tauri/src/shell.rs`, `src-tauri/shell/` | zsh startup files and zsh-syntax-highlighting |
| `src-tauri/src/files.rs`, `search.rs`, `git.rs` | Files and the file watcher, search, git |
| `src/App.tsx` | Layout, tabs, menus, settings, shortcuts |
| `src/components/` | Terminal, editor, diff view, panels, menus, dialogs |
| `src/lib/` | Editor and terminal themes, settings |
| `patches/` | A fix for xterm.js's WebGL renderer, applied by pnpm |
| `src-tauri/icons/` | App icon. `build-icon.sh` rebuilds the macOS 26 icon. |

## Data

- Recent folders: `~/Library/Application Support/com.laki.lookout/recent-folders.json`
- zsh startup files: `~/Library/Application Support/com.laki.lookout/shell/`
- Pick screenshots: `~/Library/Caches/com.laki.lookout/picks/`
- Picker log: `~/Library/Logs/com.laki.lookout/picker.log`
- Settings, themes and light or dark mode are stored by the app's web view.

## Third-party software

| Component | Used for | License |
| --- | --- | --- |
| [Tauri](https://tauri.app) | App framework | MIT or Apache-2.0 |
| [xterm.js](https://xtermjs.org) | Terminal | MIT |
| [CodeMirror](https://codemirror.net) | Editor and diff view | MIT |
| [React](https://react.dev) | Interface | MIT |
| [portable-pty](https://github.com/wezterm/wezterm/tree/main/pty) | Shell sessions | MIT |
| [ignore, grep-searcher, grep-regex](https://github.com/BurntSushi/ripgrep) | Search and the file list | MIT or Unlicense |
| [notify](https://github.com/notify-rs/notify) | Watching files | CC0-1.0 |
| [zsh-syntax-highlighting](https://github.com/zsh-users/zsh-syntax-highlighting) | Command highlighting in zsh | BSD-3-Clause |
| [Icons - Maintained](https://github.com/yusifaliyevpro/vscode-icons) | File icons in the explorer and tabs | MIT |
| [Hugeicons](https://hugeicons.com) | Icons | MIT |
| [Lucide](https://lucide.dev) | The dog and the title bar glyph | ISC |
| [iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) | Terminal theme colors | MIT |
| [tm-themes](https://github.com/shikijs/textmate-grammars-themes) | Editor theme colors | MIT |

[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) has more detail.

## License

Lookout is released under the [MIT License](LICENSE).

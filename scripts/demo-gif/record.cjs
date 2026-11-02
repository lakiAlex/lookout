// Records the frames of the README GIF (docs/demo.gif). Lookout's frontend
// runs from the Vite dev server in headless Chrome, with a fake Tauri backend:
// made-up files, git status and a Claude Code session typed out by the script.
// Nothing touches a real folder, terminal or account.
//
//   node scripts/demo-gif/record.cjs <frames folder>
//
// Needs the Vite dev server on port 1430 (scripts/demo-gif/run.sh starts it)
// and Chromium from Playwright's cache (pnpm exec playwright-core install chromium).
// Writes PNG frames and frames.json (each frame's file and how long it shows).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node scripts/demo-gif/record.cjs <frames folder>");
  process.exit(1);
}

/** The newest Chromium in Playwright's cache. */
function findChromium() {
  const base = path.join(os.homedir(), "Library/Caches/ms-playwright");
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith("chromium-")).sort().reverse() : [];
  for (const dir of dirs) {
    const inner = fs.readdirSync(path.join(base, dir)).find((d) => d.startsWith("chrome-mac"));
    if (!inner) continue;
    const app = fs.readdirSync(path.join(base, dir, inner)).find((d) => d.endsWith(".app"));
    if (app) return path.join(base, dir, inner, app, "Contents/MacOS", app.replace(".app", ""));
  }
  return null;
}

// The fake backend. Runs in the page before Lookout loads, in place of Tauri.
// The dummy content (folder, files, chat) is what the GIF shows: change it here.
const mock = () => {
  const root = "/Users/demo/Projects/tinder-for-plants";
  const tree = {
    [root]: [
      { name: ".github", dir: true }, { name: "node_modules", dir: true, ignored: true }, { name: "public", dir: true }, { name: "src", dir: true },
      { name: ".env", dir: false, ignored: true }, { name: ".gitignore", dir: false }, { name: "README.md", dir: false }, { name: "package.json", dir: false },
      { name: "tsconfig.json", dir: false }, { name: "vite.config.ts", dir: false },
    ],
    [root + "/src"]: [
      { name: "components", dir: true }, { name: "hooks", dir: true }, { name: "lib", dir: true },
      { name: "App.tsx", dir: false }, { name: "fertilizer.ts", dir: false },
      { name: "main.tsx", dir: false }, { name: "pickup-lines.ts", dir: false }, { name: "styles.css", dir: false },
    ],
    [root + "/src/components"]: [
      { name: "ChatInput.tsx", dir: false }, { name: "MatchModal.tsx", dir: false },
      { name: "NightMode.tsx", dir: false }, { name: "SwipeCard.tsx", dir: false },
      { name: "WateringReminder.tsx", dir: false },
    ],
    [root + "/src/hooks"]: [
      { name: "useFlirtDetector.ts", dir: false }, { name: "usePollination.ts", dir: false },
    ],
    [root + "/src/lib"]: [
      { name: "match.ts", dir: false }, { name: "compatibility.ts", dir: false },
    ],
  };
  const allFiles = [];
  for (const [dir, entries] of Object.entries(tree)) {
    for (const e of entries) allFiles.push(dir + "/" + e.name);
  }
  const code = `// Where the magic happens. Keep it classy.\nexport function ChatInput({ label = "Send a leaf pic" }) {\n  return <button className="send">{label}</button>;\n}\n`;
  const enc = new TextEncoder();
  const o = "\x1b[38;2;217;119;87m"; // Claude orange
  const d = "\x1b[2m";
  const r = "\x1b[0m";
  const b = "\x1b[1m";
  const pad = (text, plain, w) => text + " ".repeat(Math.max(0, w - [...plain].length));
  const del = (line) => `\x1b[48;2;72;24;28m${pad(line, line, 76)}${r}`;
  const add = (line) => `\x1b[48;2;22;58;34m${pad(line, line, 76)}${r}`;
  const box = (lines, w) => [
    `${d}\u256d${"\u2500".repeat(w)}\u256e${r}`,
    ...lines.map(([plain, styled]) => `${d}\u2502${r} ${styled}${" ".repeat(w - 1 - [...plain].length)}${d}\u2502${r}`),
    `${d}\u2570${"\u2500".repeat(w)}\u256f${r}`,
  ];
  // The terminal's lines. The first 8 show at start; the script streams the rest.
  const term = [
    `\x1b[1;34m~/Projects/tinder-for-plants${r} \x1b[35mmain${r} \x1b[32m\u276f${r} claude`,
    "",
    `${o}\u256d${"\u2500".repeat(58)}\u256e${r}`,
    `${o}\u2502${r} ${o}\u273b${r} Welcome to ${b}Claude Code${r}!${" ".repeat(32)}${o}\u2502${r}`,
    `${o}\u2502${r}${" ".repeat(58)}${o}\u2502${r}`,
    `${o}\u2502${r}   ${d}cwd: ~/Projects/tinder-for-plants${r}${" ".repeat(22)}${o}\u2502${r}`,
    `${o}\u2570${"\u2500".repeat(58)}\u256f${r}`,
    "",
    // 8: pick 1 prompt
    `${d}>${r} ${d}[Pasted text #1 +16 lines]${r} why does this button say that`,
    "",
    // 10-17: Claude's first answer
    `${o}\u23fa${r} That's the ${b}Send nudes${r} button in Chrome, on the chat with "Ficus, 3, likes long walks to the window"`,
    `  (localhost:5173/chat/ficus). Its label comes from ${b}src/components/ChatInput.tsx${r}.`,
    "",
    `${o}\u23fa${r} ${b}Update${r}(src/components/ChatInput.tsx)`,
    `  \u23bf  Updated with ${b}1${r} addition and ${b}1${r} removal`,
    `      ${del('2 - export function ChatInput({ label = "Send nudes" }) {')}`,
    `      ${add('2 + export function ChatInput({ label = "Send a leaf pic" }) {')}`,
    "",
    // 18: wrap up
    `${o}\u23fa${r} Done. The button now says ${b}Send a leaf pic${r}. What the ficus does with it is up to the ficus.`,
    "",
    // 20: pick 2 prompt
    `${d}>${r} ${d}[Pasted text #2 +12 lines]${r} the monstera gets more matches than me, why`,
    "",
    // 22-34: Claude's second answer
    `${o}\u23fa${r} ${b}Search${r}(pattern: "matchScore", path: "src")`,
    `  \u23bf  Found ${b}6${r} files`,
    "",
    `${o}\u23fa${r} ${b}src/lib/match.ts${r} gives +40 to any plant with leaves over 30 cm, added in a commit called "size matters".`,
    `  The monstera's leaves are 45 cm. Yours are not.`,
    "",
    `${o}\u23fa${r} ${b}Update${r}(src/lib/match.ts)`,
    `  \u23bf  Updated with ${b}1${r} addition and ${b}1${r} removal`,
    `      ${del("14 - score += plant.leafSize > 30 ? 40 : 0;")}`,
    `      ${add("14 + score += plant.wateringSchedule === you.wateringSchedule ? 40 : 0;")}`,
    "",
    `${o}\u23fa${r} Done. Matches now depend on compatible watering schedules. Leaf size no longer counts, officially.`,
    "",
    // 35-37: third prompt in a box
    ...box([["> [Pasted text #3 +9 lines] the cactus says I'm too clingy. bug or feature?", `> ${d}[Pasted text #3 +9 lines]${r} the cactus says I'm too clingy. bug or feature?`]], 100),
    `  ${d}? for shortcuts${r}`,
  ].join("\r\n");
  const git = {
    root, branch: "main", upstream: "origin/main", ahead: 1, behind: 0, added: 42, removed: 7,
    files: [
      { path: "src/components/ChatInput.tsx", index: ".", work: "M", from: null },
      { path: "src/components/NightMode.tsx", index: "?", work: "?", from: null },
      { path: "src/fertilizer.ts", index: "?", work: "?", from: null },
      { path: "README.md", index: "M", work: ".", from: null },
    ],
  };
  const listeners = {};
  let n = 1;
  // Tauri commands the page calls, by name. Commands not listed return null.
  const handlers = {
    home_dir: () => "/Users/demo",
    recent_folders: () => [root],
    add_recent_folder: () => [root],
    window_start: () => null,
    watch_folder: () => null,
    list_dir: ({ path: p }) => (tree[p] ?? []).map((e) => ({ ...e, path: p + "/" + e.name, ignored: !!e.ignored })),
    list_files: () => allFiles,
    git_status: () => git,
    git_stage: () => null,
    git_unstage: () => null,
    git_discard: () => null,
    git_commit: () => "abc1234",
    git_push: () => "Pushed 1 commit",
    git_pull: () => "Already up to date",
    git_fetch: () => null,
    git_branches: () => ({ current: "main", local: ["main", "dev", "feat/pollination"], remote: ["origin/main", "origin/dev"] }),
    git_switch: () => null,
    git_show: () => code,
    read_file: () => ({ text: code, binary: false, tooLarge: false }),
    write_file: () => null,
    create_path: () => null,
    rename_path: () => null,
    trash_paths: () => null,
    copy_paths: ({ paths, dir }) => paths.map((p) => dir + "/" + p.split("/").pop()),
    move_paths: ({ paths, dir }) => paths.map((p) => [p, dir + "/" + p.split("/").pop()]),
    search_files: () => ({ files: [], total: 0, truncated: false, cancelled: false }),
    window_new: () => "w2",
    picker_start: () => null,
    picker_cancel: () => null,
    picker_set_enabled: () => null,
    picker_permission: () => false,
    open_accessibility_settings: () => null,
    copy_text: () => null,
    pty_info: () => ({ cwd: root, process: "claude" }),
    pty_detach: () => null,
    pty_attach: () => null,
    pty_write: () => null,
    pty_resize: () => null,
    pty_kill: () => null,
    pty_spawn: ({ onData }) => {
      let index = 0;
      const write = (text) => window["_" + onData.id]({ index: index++, message: enc.encode(text).buffer });
      window.__write = write;
      window.__lines = term.split("\r\n");
      setTimeout(() => write(window.__lines.slice(0, 8).join("\r\n") + "\r\n"), 300);
      return "s1";
    },
    notice_post: () => null,
    notices_list: () => {
      const now = Date.now();
      const notice = (id, kind, title, body, tabTitle, minutes, read) => ({ id, kind, title, body, tabId: "main:tab1", tabTitle, time: now - minutes * 60000, read });
      return [
        notice(4, "claude", "Claude finished", "The fern's bio now says \"I like it humid\" instead of listing moisture requirements.", "tinder-for-plants", 0, false),
        notice(3, "claude-input", "Claude needs your input", "Claude needs your permission to use Bash: rm -rf src/exes", "tinder-for-plants", 2, false),
        notice(2, "claude", "Claude finished", "Cactus compatibility score fixed. Prickly personalities no longer get a bonus.", "tinder-for-plants", 8, true),
        notice(1, "done", "pnpm test --grep \"long distance\"", "Finished in 1m 9s", "tinder-for-plants", 14, true),
      ];
    },
    notices_read: () => null,
    notice_remove: () => null,
    notices_clear: () => null,
    notice_open: () => null,
    claude_reply: () => "The button now says Send a leaf pic.",
    "plugin:event|listen": ({ event, handler }) => {
      listeners[event] = handler;
      return n++;
    },
  };
  window.__emit = (event, payload) => listeners[event] && window["_" + listeners[event]]({ event, id: 1, payload });
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (cb) => {
      const id = n++;
      window["_" + id] = cb;
      return id;
    },
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => (handlers[cmd] ? handlers[cmd](args || {}) : cmd.startsWith("plugin:") ? n++ : null),
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
};

// Elements "picked" on screen, sent to Claude in the tour.
const picks = [
  { app: "Messages", label: "Messages: message the cactus left me on read" },
  { app: "Calendar", label: "Calendar: event Date night with the monstera" },
  { app: "Google Chrome", label: "Google Chrome: button Send nudes" },
].map((p, i) => ({ id: "p" + i, ...p, report: "", image: null, frame: { x: 0, y: 0, width: 10, height: 10 }, bundleId: null }));

(async () => {
  const executablePath = findChromium();
  if (!executablePath) throw new Error("No Chromium in ~/Library/Caches/ms-playwright. Run: pnpm exec playwright-core install chromium");
  // WebGL off: xterm.js then draws with the DOM renderer, which screenshots reliably.
  const browser = await chromium.launch({ executablePath, args: ["--disable-webgl", "--disable-3d-apis"] });
  const page = await browser.newPage({ viewport: { width: 1320, height: 840 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(mock);
  await page.addInitScript(() => localStorage.setItem("lookout.fontSize", "14"));
  await page.goto("http://localhost:1430/");
  await page.waitForTimeout(1500);
  fs.mkdirSync(outDir, { recursive: true });
  const frames = [];
  /** Saves a frame that shows for `ms` milliseconds in the GIF. */
  const shot = async (ms) => {
    const file = path.join(outDir, `f${String(frames.length).padStart(3, "0")}.png`);
    await page.screenshot({ path: file });
    frames.push({ file, ms });
  };
  const write = (text) => page.evaluate((t) => window.__write(t), text);
  const line = (i) => page.evaluate((k) => window.__lines[k], i);
  /** Types text into the terminal, a few characters per frame. */
  const type = async (text) => {
    for (let i = 0; i < text.length; i += 3) {
      await write(text.slice(i, i + 3));
      await page.waitForTimeout(30);
      await shot(60);
    }
  };
  /** Prints the transcript's lines `from` to `to`, one frame each. */
  const stream = async (from, to, ms = 220) => {
    for (let i = from; i < to; i++) {
      await write((await line(i)) + "\r\n");
      await page.waitForTimeout(30);
      if ((await line(i)) !== "") await shot(ms);
    }
  };
  // Keeps the pointer off buttons, so no hover state or tooltip is captured.
  const rest = () => page.mouse.move(1000, 300);

  await rest();
  await shot(1400);
  // 1. A pick arrives from Chrome and Claude answers.
  await page.evaluate((p) => window.__emit("picked", p), picks[2]);
  await page.waitForTimeout(200);
  await write("\x1b[2m>\x1b[0m \x1b[2m[Pasted text #1 +16 lines]\x1b[0m ");
  await page.waitForTimeout(50);
  await shot(900);
  await type("why does this button say that");
  await shot(500);
  await write("\r\n\r\n");
  await stream(10, 19);
  await shot(1600);
  // 2. A second question with another pick.
  await page.evaluate((p) => window.__emit("picked", p), picks[1]);
  await write("\x1b[2m>\x1b[0m \x1b[2m[Pasted text #2 +12 lines]\x1b[0m ");
  await page.waitForTimeout(100);
  await shot(500);
  await type("the monstera gets more matches than me, why");
  await write("\r\n\r\n");
  await stream(22, 35);
  await shot(2000);
  // 3. The Files panel: expand src and components.
  await page.locator('button[aria-label="Files (\u21e7\u2318E)"]').click();
  await rest();
  await page.waitForTimeout(250);
  await page.locator(".tree-row", { hasText: "src" }).first().click();
  await page.waitForTimeout(250);
  await shot(500);
  await page.locator(".tree-row", { hasText: "components" }).first().click();
  await page.waitForTimeout(250);
  await shot(1500);
  // 4. Source Control panel.
  await page.locator('button[aria-label="Source Control (\u2303\u21e7G)"]').click();
  await rest();
  await page.waitForTimeout(400);
  await shot(1800);
  await page.locator('button[aria-label="Source Control (\u2303\u21e7G)"]').click();
  await rest();
  await page.waitForTimeout(300);
  // 5. The notifications under the bell.
  await page.locator(".bell-button").click();
  await page.waitForTimeout(500);
  await shot(2400);
  await page.keyboard.press("Escape");
  await rest();
  await page.waitForTimeout(300);
  // 6. The settings menu.
  await page.locator('button[aria-label="Settings"]').click();
  await page.waitForTimeout(250);
  await page.locator(".context-menu .menu-item", { hasText: "Terminal theme" }).hover();
  await page.waitForTimeout(400);
  await shot(2400);
  await page.keyboard.press("Escape");
  await rest();
  await page.waitForTimeout(300);
  await shot(1200);

  fs.writeFileSync(path.join(outDir, "frames.json"), JSON.stringify(frames));
  console.log(frames.length, "frames", errors.length ? "page errors:\n" + errors.join("\n") : "no page errors");
  await browser.close();
  if (errors.length) process.exit(1);
})();

# Making the README GIF

`docs/demo.gif` is the animated screenshot at the top of the README. It is recorded from Lookout's real frontend with made-up content, so it never shows a real folder, terminal, client or account.

## Record it

```sh
pnpm install
pnpm exec playwright-core install chromium   # once, if ~/Library/Caches/ms-playwright has no Chromium
python3 -m pip install --user Pillow         # once
scripts/demo-gif/run.sh                       # writes docs/demo.gif
```

Stop `pnpm tauri dev` first: the script needs port 1430. To try changes without touching the README, give it another file: `scripts/demo-gif/run.sh /tmp/test.gif`.

Then update the image's alt text in `README.md` so it describes what the new GIF shows.

## How it works

The files are in `scripts/demo-gif/`:

| File | What it does |
| --- | --- |
| `run.sh` | Starts the Vite dev server, runs the recorder, stops the server and builds the GIF. |
| `record.cjs` | Opens Lookout in headless Chrome through Playwright with a fake Tauri backend, clicks through a short tour and saves a PNG for each frame, with how long it shows. |
| `make-gif.py` | Rounds the window corners, draws the close, minimize and zoom buttons (the page has none), puts all frames on one palette so colors do not flicker, and writes the GIF. |

The fake backend is the `mock` function in `record.cjs`. It answers the Tauri commands the page calls: the file tree, git status, the notification list and a terminal session. Commands it does not list return nothing. The terminal session is the `term` array: the first 8 lines show at start and the tour prints the rest line by line, so it looks like Claude is answering. Picks from the element picker are sent with `window.__emit("picked", ...)`.

The tour is the list of steps at the end of `record.cjs`. `shot(ms)` saves a frame that stays on screen for `ms` milliseconds, `type()` types text a few characters per frame, and `stream()` prints transcript lines. `rest()` moves the pointer away so no hover state or tooltip ends up in a frame.

## What the GIF shows

**Dummy content: funny and a bit sexual.** The folder, files, chat, picks and notifications are innuendo jokes, like the current `tinder-for-plants` project where a "Send nudes" button becomes "Send a leaf pic" and the monstera gets more matches because of leaf size. Keep it to double meanings and jokes, nothing explicit. Use only made-up names and paths (`/Users/demo/...`): no real people, clients or companies.

**Show the features.** Each step should show something Lookout does:

- A pick from another app pasted into Claude Code, and Claude answering and editing code.
- The Files panel and Source Control panel.
- The git changes button and the notification bell with a few cards.
- The settings menu.
- When features are added, a step for them, like tabs dragged into a new window or files dropped into the Files panel.

**Dark mode only.** Do not switch to light mode in the tour.

Keep it short: about 50 to 60 frames, around 30 seconds, and under 3 MB.

## When the app changes

- **A new Tauri command** that the page calls at start needs an answer in `handlers` in `record.cjs`, or the page may break. The recorder prints page errors and stops when there are any.
- **A renamed button or class** breaks the tour step that clicks it. The steps find elements by `aria-label` and class names like `.bell-button` and `.tree-row`.
- **Moved window buttons:** the button position in `make-gif.py` (center 17 points from the top, first button 23 points from the left, 20 apart) follows `trafficLightPosition` in `src-tauri/tauri.conf.json`. Pass other values as the third and fourth arguments when it changes.

Look at a few frames before committing. This prints the frame count and saves frame 30 as a PNG:

```sh
python3 -E -c "from PIL import Image; im = Image.open('docs/demo.gif'); print(im.n_frames); im.seek(30); im.convert('RGB').save('/tmp/frame.png')"
```

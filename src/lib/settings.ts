/** App settings from the gear menu. Only values the user changed are stored,
 * so a new default applies to everyone who never picked one. */
export interface Settings {
  cursorStyle: "underline" | "bar" | "block";
  cursorBlink: boolean;
  /** An id from FONTS. */
  font: string;
  lineHeight: number;
  /** Option sends Meta (Esc + key) instead of typing characters like @ and €. */
  optionIsMeta: boolean;
  copyOnSelect: boolean;
  scrollback: number;
  wordWrap: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  cursorStyle: "underline",
  cursorBlink: true,
  font: "sf-mono",
  lineHeight: 1.2,
  optionIsMeta: false,
  copyOnSelect: false,
  scrollback: 10000,
  wordWrap: false,
};

const KEY = "lookout.settings";

function stored(): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function loadSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...stored() };
}

export function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  localStorage.setItem(KEY, JSON.stringify({ ...stored(), [key]: value }));
}

/** Monospace fonts. The first three come with macOS; the rest are listed when installed. */
export const FONTS = [
  { id: "sf-mono", label: "SF Mono", family: null, css: 'ui-monospace, "SF Mono", Menlo, monospace' },
  { id: "menlo", label: "Menlo", family: "Menlo", css: "Menlo, monospace" },
  { id: "monaco", label: "Monaco", family: "Monaco", css: "Monaco, Menlo, monospace" },
  { id: "jetbrains-mono", label: "JetBrains Mono", family: "JetBrains Mono", css: '"JetBrains Mono", Menlo, monospace' },
  { id: "fira-code", label: "Fira Code", family: "Fira Code", css: '"Fira Code", Menlo, monospace' },
  { id: "cascadia-code", label: "Cascadia Code", family: "Cascadia Code", css: '"Cascadia Code", Menlo, monospace' },
  { id: "source-code-pro", label: "Source Code Pro", family: "Source Code Pro", css: '"Source Code Pro", Menlo, monospace' },
  { id: "ibm-plex-mono", label: "IBM Plex Mono", family: "IBM Plex Mono", css: '"IBM Plex Mono", Menlo, monospace' },
  { id: "hack", label: "Hack", family: "Hack", css: "Hack, Menlo, monospace" },
  { id: "geist-mono", label: "Geist Mono", family: "Geist Mono", css: '"Geist Mono", Menlo, monospace' },
];

const BUILT_IN = new Set(["sf-mono", "menlo", "monaco"]);

/** True when text in `family` measures differently from the fallback fonts,
 * which means the font is installed. */
function installed(family: string): boolean {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return false;
  const sample = "mmmmmmmmmmlli10OO@#";
  return ["monospace", "serif"].some((fallback) => {
    ctx.font = `72px ${fallback}`;
    const base = ctx.measureText(sample).width;
    ctx.font = `72px "${family}", ${fallback}`;
    return ctx.measureText(sample).width !== base;
  });
}

let available: typeof FONTS | null = null;

export function availableFonts(): typeof FONTS {
  available ??= FONTS.filter((f) => BUILT_IN.has(f.id) || (f.family !== null && installed(f.family)));
  return available;
}

export function fontCss(id: string): string {
  return (FONTS.find((f) => f.id === id) ?? FONTS[0]).css;
}

export const LINE_HEIGHTS = [
  { value: 1.0, label: "Compact" },
  { value: 1.2, label: "Normal" },
  { value: 1.4, label: "Relaxed" },
];

export const SCROLLBACK = [1000, 10000, 50000];

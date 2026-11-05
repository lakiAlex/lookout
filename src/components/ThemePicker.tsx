import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Theme } from "../lib/theme";
import { DEFAULT_WINDOW, THEMES } from "../lib/themes";
import { Check, Colors } from "./icons";

/** The theme button in the title bar and its panel of themes. Each theme shows
 * as a small window in its colors: a terminal on its side bar color and a file
 * on its editor color, with its text colors. */
export function ThemePicker(props: { current: string; mode: Theme; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onBlur = () => setOpen(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  const current = THEMES.find((t) => t.id === props.current) ?? THEMES[0];

  return (
    <div className="theme-picker" ref={ref}>
      <button type="button" className={`theme-button${open ? " open" : ""}`} title={`Theme: ${current.label}`} aria-label="Theme" onClick={() => setOpen((o) => !o)}>
        <Colors size={16} />
      </button>
      {open && (
        <div className="theme-panel" onContextMenu={(e) => e.preventDefault()}>
          <div className="theme-panel-head">
            <span className="theme-panel-heading">Theme</span>
            <span className="theme-panel-mode">{props.mode === "dark" ? "Dark mode" : "Light mode"}</span>
          </div>
          <div className="theme-grid">
            {THEMES.map((t, i) => {
              // A theme without a light version shows its dark look, marked as dark only.
              const light = props.mode === "light" && !!t.light;
              const version = light ? t.light! : t.dark;
              const w = version.window ?? DEFAULT_WINDOW[light ? "light" : "dark"];
              const s = version.syntax;
              const term = version.terminal;
              const darkOnly = props.mode === "light" && !t.light;
              return (
                <button
                  type="button"
                  key={t.id}
                  className={`theme-card${t.id === current.id ? " current" : ""}`}
                  style={{ "--i": i } as CSSProperties}
                  title={darkOnly ? `${t.label} has no light version: light mode shows Default` : t.label}
                  onClick={() => props.onPick(t.id)}
                >
                  <span className="theme-preview" style={{ background: w.chrome }}>
                    <span className="theme-preview-term">
                      <i style={{ background: term.blue, width: "70%" }} />
                      <i style={{ background: w.fg, width: "45%" }} />
                      <i style={{ background: term.green, width: "58%" }} />
                    </span>
                    <span className="theme-preview-file" style={{ background: w.bg }}>
                      <i style={{ background: s.keyword, width: "38%" }} />
                      <i style={{ background: s.function, width: "64%" }} />
                      <i style={{ background: s.string, width: "48%" }} />
                      <i style={{ background: s.comment, width: "30%" }} />
                    </span>
                  </span>
                  <span className="theme-card-label">
                    <span>{t.label}</span>
                    {t.id === current.id && <Check size={12} />}
                  </span>
                  {darkOnly && <span className="theme-card-note">Dark only</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

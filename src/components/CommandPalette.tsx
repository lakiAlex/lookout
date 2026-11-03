import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** A command in the palette. `run` either does it, or returns the next list to pick from (like branches). */
export interface Command {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  /** Extra words that find the command, like "dark light" for the theme. */
  keywords?: string;
  run: () => void | Command[] | Promise<Command[]>;
}

/** Every typed letter in order, word starts counting more; null when the label does not match. */
function score(text: string, query: string): number | null {
  const lower = text.toLowerCase();
  let total = 0;
  let at = 0;
  let last = -2;
  for (const ch of query.toLowerCase().replace(/\s+/g, "")) {
    const found = lower.indexOf(ch, at);
    if (found < 0) return null;
    total += 1 + (found === last + 1 ? 2 : 0) + (found === 0 || lower[found - 1] === " " ? 2 : 0);
    last = found;
    at = found + 1;
  }
  return total - text.length * 0.01;
}

/** ⇧⌘P: type to find a command, arrow keys and Enter to run it. */
export function CommandPalette(props: { commands: Command[]; onClose: () => void }) {
  /** Lists opened from a command, like the branches; Backspace on an empty search goes back. */
  const [pages, setPages] = useState<{ title: string; commands: Command[] }[]>([]);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const page = pages[pages.length - 1];
  const commands = page?.commands ?? props.commands;
  const matches = useMemo(() => {
    if (!query.trim()) return commands;
    return commands
      .map((c) => [c, score(`${c.label} ${c.keywords ?? ""}`, query)] as const)
      .filter((x): x is readonly [Command, number] => x[1] !== null)
      .sort((a, b) => b[1] - a[1])
      .map(([c]) => c);
  }, [commands, query]);

  useEffect(() => setIndex(0), [query, pages.length]);
  useEffect(() => {
    list.current?.querySelector(".quick-row.active")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = async (command: Command) => {
    setBusy(true);
    const next = await Promise.resolve(command.run()).finally(() => setBusy(false));
    if (Array.isArray(next)) {
      setPages((p) => [...p, { title: command.label, commands: next }]);
      setQuery("");
      input.current?.focus();
    } else props.onClose();
  };

  return (
    <div className="quick-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="quick command-quick">
        {page && <div className="command-crumb">{page.title}</div>}
        <input
          ref={input}
          autoFocus
          value={query}
          placeholder={page ? "Pick one" : "Type a command"}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(matches.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (matches[index] && !busy) void run(matches[index]);
            } else if (e.key === "Backspace" && !query && pages.length) {
              e.preventDefault();
              setPages((p) => p.slice(0, -1));
            } else if (e.key === "Escape") props.onClose();
          }}
        />
        <div ref={list} className="quick-list">
          {matches.map((command, i) => (
            <div
              key={command.id}
              className={`quick-row command-row${i === index ? " active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                if (!busy) void run(command);
              }}
            >
              <span className="command-icon">{command.icon}</span>
              <span className="tree-name">{command.label}</span>
              {command.shortcut && <span className="command-shortcut">{command.shortcut}</span>}
            </div>
          ))}
          {matches.length === 0 && <div className="panel-empty">No matching commands.</div>}
        </div>
      </div>
    </div>
  );
}

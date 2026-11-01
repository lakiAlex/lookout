import { useEffect, useMemo, useRef, useState } from "react";
import { basename } from "../api";
import { iconUrl } from "../icons";

/** Scores `path` for `query` typed as a subsequence; null when it does not match.
 * Matches in the file name, consecutive letters and word starts count more. */
function score(path: string, query: string): number | null {
  const lower = path.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const nameStart = lower.lastIndexOf("/") + 1;
  let total = 0;
  let last = -2;
  let at = 0;
  for (const ch of q) {
    const found = lower.indexOf(ch, at);
    if (found < 0) return null;
    total += 1;
    if (found === last + 1) total += 3;
    if (found >= nameStart) total += 2;
    if (found === 0 || "/._-".includes(lower[found - 1])) total += 2;
    last = found;
    at = found + 1;
  }
  return total - path.length * 0.01;
}

export function QuickOpen(props: { files: string[] | null; onOpen: (rel: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const files = props.files ?? [];
    if (!query.trim()) return files.slice(0, 60);
    const scored: [string, number][] = [];
    for (const f of files) {
      const s = score(f, query);
      if (s !== null) scored.push([f, s]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, 60).map(([f]) => f);
  }, [props.files, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector(".quick-row.active")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <div className="quick-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="quick">
        <input
          autoFocus
          value={query}
          placeholder={props.files ? "Go to file" : "Reading files…"}
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
              if (matches[index]) props.onOpen(matches[index]);
            } else if (e.key === "Escape") props.onClose();
          }}
        />
        <div ref={list} className="quick-list">
          {matches.map((rel, i) => (
            <div
              key={rel}
              className={`quick-row${i === index ? " active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                props.onOpen(rel);
              }}
            >
              <img className="tree-icon" src={iconUrl(basename(rel), false)} alt="" />
              <span className="tree-name">{basename(rel)}</span>
              <span className="result-dir">{rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""}</span>
            </div>
          ))}
          {props.files && matches.length === 0 && <div className="panel-empty">No matching files.</div>}
        </div>
      </div>
    </div>
  );
}

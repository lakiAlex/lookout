import { CaseSensitive, ChevronRight, Ellipsis, LoaderCircle, Regex, WholeWord, X } from "./icons";
import { useEffect, useRef, useState } from "react";
import { api, basename, dirname, toAppError, type SearchOptions, type SearchResult } from "../api";
import { iconUrl } from "../icons";
import { PanelClose } from "./PanelClose";

interface SearchPanelProps {
  root: string;
  onClose: () => void;
  focusToken: number;
  onOpen: (path: string, line: number, from: number, to: number) => void;
}

const countFormat = new Intl.NumberFormat();

export function SearchPanel(props: SearchPanelProps) {
  const [options, setOptions] = useState<SearchOptions>({ query: "", matchCase: false, wholeWord: false, regex: false, include: "", exclude: "" });
  const [showFilters, setShowFilters] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [props.focusToken]);

  useEffect(() => {
    if (!options.query) {
      setResult(null);
      setError(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      setBusy(true);
      api.search(props.root, options).then(
        (r) => {
          if (!current || r.cancelled) return;
          setResult(r);
          setError(null);
          setCollapsed(new Set());
          setBusy(false);
        },
        (e) => {
          if (!current) return;
          setError(toAppError(e).message);
          setResult(null);
          setBusy(false);
        },
      );
    }, 220);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [options, props.root]);

  const toggle = (key: "matchCase" | "wholeWord" | "regex", title: string, icon: React.ReactNode) => (
    <button
      type="button"
      className={`input-toggle${options[key] ? " on" : ""}`}
      title={title}
      onClick={() => setOptions((o) => ({ ...o, [key]: !o[key] }))}
    >
      {icon}
    </button>
  );

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Search</span>
        <div className="panel-actions">
          <button type="button" className={`icon-button${showFilters ? " on" : ""}`} title="Files to include and exclude" onClick={() => setShowFilters((s) => !s)}>
            <Ellipsis size={15} />
          </button>
          <PanelClose onClose={props.onClose} />
        </div>
      </div>
      <div className="search-form">
        <div className="search-input">
          <input
            ref={input}
            value={options.query}
            placeholder="Search"
            spellCheck={false}
            onChange={(e) => setOptions((o) => ({ ...o, query: e.target.value }))}
            onKeyDown={(e) => e.key === "Escape" && setOptions((o) => ({ ...o, query: "" }))}
          />
          {toggle("matchCase", "Match Case", <CaseSensitive size={15} />)}
          {toggle("wholeWord", "Match Whole Word", <WholeWord size={15} />)}
          {toggle("regex", "Use Regular Expression", <Regex size={14} />)}
        </div>
        {showFilters && (
          <>
            <input
              className="search-filter"
              value={options.include}
              placeholder="Files to include, like src/**, *.php"
              spellCheck={false}
              onChange={(e) => setOptions((o) => ({ ...o, include: e.target.value }))}
            />
            <input
              className="search-filter"
              value={options.exclude}
              placeholder="Files to exclude"
              spellCheck={false}
              onChange={(e) => setOptions((o) => ({ ...o, exclude: e.target.value }))}
            />
          </>
        )}
      </div>
      <div className="search-status">
        {busy && <LoaderCircle size={12} className="spin" />}
        {error && <span className="error-text">{error}</span>}
        {result &&
          !error &&
          (result.total === 0
            ? "No results"
            : `${countFormat.format(result.total)} results in ${countFormat.format(result.files.length)} files${result.truncated ? " (stopped at 20,000)" : ""}`)}
      </div>
      <div className="search-results">
        {result?.files.map((file) => {
          const closed = collapsed.has(file.path);
          return (
            <div key={file.path}>
              <div
                className="result-file"
                title={file.rel}
                onClick={() =>
                  setCollapsed((s) => {
                    const next = new Set(s);
                    if (next.has(file.path)) next.delete(file.path);
                    else next.add(file.path);
                    return next;
                  })
                }
              >
                <span className={`tree-chevron${closed ? "" : " open"}`}>
                  <ChevronRight size={13} />
                </span>
                <img className="tree-icon" src={iconUrl(basename(file.path), false)} alt="" />
                <span className="tree-name">{basename(file.path)}</span>
                <span className="result-dir">{dirname(file.rel) === "/" ? "" : dirname(file.rel)}</span>
                <span className="result-count">{file.matches.length}</span>
                <button
                  type="button"
                  className="result-dismiss"
                  title="Dismiss"
                  onClick={(e) => {
                    e.stopPropagation();
                    setResult((r) => r && { ...r, files: r.files.filter((f) => f.path !== file.path), total: r.total - file.matches.length });
                  }}
                >
                  <X size={12} />
                </button>
              </div>
              {!closed &&
                file.matches.map((m, i) => {
                  const parts: React.ReactNode[] = [];
                  let at = 0;
                  m.ranges.forEach(([s, e], j) => {
                    parts.push(m.text.slice(at, s), <mark key={j}>{m.text.slice(s, e)}</mark>);
                    at = e;
                  });
                  parts.push(m.text.slice(at));
                  const [from, to] = m.ranges[0] ?? [0, 0];
                  return (
                    <div key={i} className="result-line" title={`Line ${m.line}`} onClick={() => props.onOpen(file.path, m.line, from, to)}>
                      {parts}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

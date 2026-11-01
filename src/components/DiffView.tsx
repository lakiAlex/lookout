import { LanguageSupport } from "@codemirror/language";
import { MergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { FileText } from "./icons";
import { useEffect, useRef, useState } from "react";
import { api, basename } from "../api";
import { editorTheme, highlight, languageFor } from "../lib/editor";

interface DiffViewProps {
  root: string;
  path: string;
  /** Staged: last commit against the index. Otherwise: the index against the file on disk. */
  staged: boolean;
  active: boolean;
  /** Changes when the files or the repository changed, to load again. */
  version: number;
  onOpenFile: () => void;
}

export function DiffView(props: DiffViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const merge = useRef<MergeView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [summary, setSummary] = useState("");

  useEffect(() => {
    let current = true;
    const full = `${props.root}/${props.path}`;
    const load = async () => {
      const original = await api.gitShow(props.root, props.staged ? "HEAD" : "", props.path);
      let modified = "";
      if (props.staged) modified = await api.gitShow(props.root, "", props.path);
      else {
        const file = await api.readFile(full).catch(() => null);
        if (file?.binary || file?.tooLarge) {
          setProblem(file.binary ? "This file is not text." : "This file is larger than 8 MB.");
          return;
        }
        modified = file?.text ?? "";
      }
      const lang = await languageFor(basename(props.path));
      if (!current || !host.current) return;
      setProblem(null);
      const base: Extension[] = [
        lineNumbers(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        editorTheme,
        highlight,
        lang instanceof LanguageSupport ? lang : [],
      ];
      merge.current?.destroy();
      merge.current = new MergeView({
        a: { doc: original, extensions: base },
        b: { doc: modified, extensions: base },
        parent: host.current,
        collapseUnchanged: { margin: 3, minSize: 6 },
        highlightChanges: true,
        gutter: true,
      });
      const added = modified.split("\n").length;
      const removed = original.split("\n").length;
      setSummary(original === modified ? "No changes" : `${removed} lines before, ${added} after`);
    };
    load().catch((e) => current && setProblem(String(e?.message ?? e)));
    return () => {
      current = false;
    };
  }, [props.root, props.path, props.staged, props.version]);

  useEffect(() => () => merge.current?.destroy(), []);

  return (
    <div className={`diff-view${props.active ? "" : " hidden"}`}>
      <div className="diff-header">
        <span className="diff-title">
          {props.path}
          <span className="diff-mode">{props.staged ? "Staged: last commit ↔ staged" : "Changes: staged ↔ working copy"}</span>
        </span>
        <span className="diff-summary">{summary}</span>
        <button type="button" className="button small" onClick={props.onOpenFile}>
          <FileText size={13} /> Open File
        </button>
      </div>
      {problem ? <div className="editor-problem">{problem}</div> : <div ref={host} className="diff-host" />}
    </div>
  );
}

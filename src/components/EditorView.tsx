import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView as CodeMirror,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { api, basename } from "../api";
import { editorTheme, highlight, languageFor } from "../lib/editor";

export interface EditorHandle {
  save: () => Promise<boolean>;
  reload: () => void;
  goTo: (line: number, from?: number, to?: number) => void;
  find: () => void;
  isDirty: () => boolean;
  focus: () => void;
  /** The text in the editor, saved or not. */
  text: () => string;
}

export const editors = new Map<string, EditorHandle>();

interface EditorViewProps {
  tabId: string;
  path: string;
  active: boolean;
  /** Line (from 1) and character range to select after loading. */
  reveal: { line: number; from?: number; to?: number } | null;
  /** Unsaved text to show in place of the file's, for a tab moved from another window. */
  text?: string;
  wordWrap: boolean;
  onDirty: (dirty: boolean) => void;
  onSaved: () => void;
  onError: (message: string) => void;
}

export function EditorView(props: EditorViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<CodeMirror | null>(null);
  const saved = useRef("");
  const dirty = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const language = useRef(new Compartment());
  const wrap = useRef(new Compartment());
  const latest = useRef(props);
  latest.current = props;

  const setDirty = (value: boolean) => {
    if (dirty.current !== value) {
      dirty.current = value;
      latest.current.onDirty(value);
    }
  };

  const save = async () => {
    const v = view.current;
    if (!v) return false;
    const text = v.state.doc.toString();
    try {
      await api.writeFile(latest.current.path, text);
      saved.current = text;
      setDirty(false);
      latest.current.onSaved();
      return true;
    } catch (e) {
      latest.current.onError(`Could not save ${basename(latest.current.path)}: ${String((e as { message?: string })?.message ?? e)}`);
      return false;
    }
  };

  const goTo = (line: number, from?: number, to?: number) => {
    const v = view.current;
    if (!v) return;
    const lineInfo = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)));
    const anchor = lineInfo.from + (from ?? 0);
    const head = lineInfo.from + (to ?? from ?? 0);
    v.dispatch({
      selection: EditorSelection.single(Math.min(anchor, lineInfo.to), Math.min(head, lineInfo.to)),
      effects: CodeMirror.scrollIntoView(anchor, { y: "center" }),
    });
    v.focus();
  };

  const load = async (keepSelection: boolean) => {
    try {
      const file = await api.readFile(latest.current.path);
      if (file.binary || file.tooLarge) {
        setProblem(file.binary ? "This file is not text." : "This file is larger than 8 MB.");
        return;
      }
      setProblem(null);
      saved.current = file.text;
      const v = view.current;
      if (!v) return;
      if (v.state.doc.toString() === file.text) return;
      const selection = keepSelection ? v.state.selection.main : null;
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: file.text },
        selection: selection ? EditorSelection.single(Math.min(selection.anchor, file.text.length)) : undefined,
      });
      setDirty(false);
    } catch (e) {
      setProblem(String((e as { message?: string })?.message ?? e));
    }
  };

  useEffect(() => {
    const v = new CodeMirror({
      parent: host.current!,
      state: EditorState.create({
        doc: "",
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          keymap.of([
            { key: "Mod-s", run: () => (void save(), true) },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          language.current.of([]),
          wrap.current.of(props.wordWrap ? CodeMirror.lineWrapping : []),
          editorTheme,
          highlight,
          CodeMirror.updateListener.of((update) => {
            if (update.docChanged) setDirty(update.state.doc.toString() !== saved.current);
          }),
        ],
      }),
    });
    view.current = v;
    editors.set(props.tabId, {
      save,
      reload: () => {
        if (!dirty.current) void load(true);
      },
      goTo,
      find: () => openSearchPanel(v),
      isDirty: () => dirty.current,
      focus: () => v.focus(),
      text: () => v.state.doc.toString(),
    });
    void load(false).then(() => {
      const text = latest.current.text;
      if (text !== undefined && text !== v.state.doc.toString()) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
      const r = latest.current.reveal;
      if (r) goTo(r.line, r.from, r.to);
    });
    void languageFor(basename(props.path)).then((lang) => {
      if (lang) v.dispatch({ effects: language.current.reconfigure(lang) });
    });
    return () => {
      editors.delete(props.tabId);
      v.destroy();
    };
  }, []);

  useEffect(() => {
    if (props.reveal && view.current?.state.doc.length) goTo(props.reveal.line, props.reveal.from, props.reveal.to);
  }, [props.reveal]);

  useEffect(() => {
    if (props.active) requestAnimationFrame(() => view.current?.focus());
  }, [props.active]);

  useEffect(() => {
    view.current?.dispatch({ effects: wrap.current.reconfigure(props.wordWrap ? CodeMirror.lineWrapping : []) });
  }, [props.wordWrap]);

  return (
    <div className={`editor-view${props.active ? "" : " hidden"}`}>
      {problem && <div className="editor-problem">{problem}</div>}
      <div ref={host} className="editor-host" style={problem ? { display: "none" } : undefined} />
    </div>
  );
}

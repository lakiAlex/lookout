// Shared CodeMirror setup for the editor and the diff view. Colors come from
// CSS variables (styles.css), so light and dark mode need no reconfiguring.
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "var(--editor-font-size, 13px)",
    backgroundColor: "var(--bg)",
    color: "var(--fg)",
  },
  ".cm-scroller": {
    fontFamily: 'var(--code-font, ui-monospace, "SF Mono", Menlo, Monaco, monospace)',
    lineHeight: "1.55",
  },
  ".cm-content": { caretColor: "var(--fg-strong)", padding: "6px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg-strong)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--editor-selection) !important",
  },
  ".cm-activeLine": { backgroundColor: "var(--editor-active-line)" },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--fg-3)",
    border: "none",
    paddingLeft: "6px",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg-strong)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 8px", minWidth: "36px" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--fg-3)" },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "var(--editor-bracket)",
    outline: "none",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--editor-match)" },
  ".cm-searchMatch": { backgroundColor: "var(--editor-search)", outline: "1px solid var(--editor-search-border)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--editor-search-active)" },
  ".cm-panels": { backgroundColor: "var(--bg-subtle)", color: "var(--fg)", borderColor: "var(--border)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panel.cm-search": { padding: "8px 10px", fontFamily: "var(--font)", fontSize: "12.5px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontFamily: "var(--font)" },
  ".cm-textfield": {
    height: "26px",
    width: "auto",
    padding: "0 8px",
    borderRadius: "6px",
    border: "1px solid var(--input-border)",
    background: "var(--bg-muted)",
    color: "var(--fg)",
  },
  ".cm-button": {
    height: "26px",
    padding: "0 10px",
    borderRadius: "6px",
    border: "1px solid var(--input-border)",
    backgroundImage: "none",
    background: "var(--bg-muted)",
    color: "var(--fg)",
  },
  ".cm-tooltip": {
    border: "none",
    borderRadius: "8px",
    backgroundColor: "var(--bg-subtle)",
    boxShadow: "var(--shadow-menu)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--on-accent)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-muted)", border: "none", color: "var(--fg-2)" },
});

export const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "var(--syn-keyword)" },
    { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--syn-function)" },
    { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: "var(--syn-type)" },
    { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
    { tag: [t.tagName, t.angleBracket], color: "var(--syn-tag)" },
    { tag: [t.variableName, t.definition(t.variableName)], color: "var(--syn-variable)" },
    { tag: [t.operator, t.punctuation, t.separator], color: "var(--syn-punctuation)" },
    { tag: [t.heading], color: "var(--syn-keyword)", fontWeight: "600" },
    { tag: [t.link, t.url], color: "var(--syn-function)", textDecoration: "underline" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.strong], fontWeight: "600" },
    { tag: [t.invalid], color: "var(--syn-tag)" },
  ]),
);

/** The language for a file name, loaded on first use. */
export async function languageFor(name: string) {
  const description = LanguageDescription.matchFilename(languages, name);
  if (!description) return null;
  try {
    return await description.load();
  } catch {
    return null;
  }
}

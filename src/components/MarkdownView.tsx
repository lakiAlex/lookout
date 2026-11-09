import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, type MouseEvent, type KeyboardEvent, type RefObject } from "react";
import { dirname } from "../api";
import { addHeadingIds, highlightCodeBlocks, isUrl, linkPath, renderMarkdown, resolvePath } from "../lib/markdown";

interface MarkdownViewProps {
  path: string;
  /** The file's text, saved or not. */
  text: string;
  hidden: boolean;
  /** The scrolling element, for focusing it. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** A link to another file was clicked. */
  onOpenFile: (path: string) => void;
}

/** A Markdown file as a page. It keeps its place while the editor is shown. */
export function MarkdownView(props: MarkdownViewProps) {
  const dir = dirname(props.path);
  const html = useMemo(() => renderMarkdown(props.text, dir), [props.text, dir]);
  const page = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = page.current;
    if (!root) return;
    addHeadingIds(root);
    let current = true;
    void highlightCodeBlocks(root, () => current);
    return () => {
      current = false;
    };
  }, [html]);

  // Links go to the browser, to a heading on the page, or to another file in a tab.
  const onClick = (e: MouseEvent) => {
    const link = (e.target as Element).closest("a[href]");
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      page.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start" });
    } else if (/^(https?|mailto):/i.test(href)) {
      void openUrl(href);
    } else if (!isUrl(href) && linkPath(href)) {
      props.onOpenFile(resolvePath(dir, linkPath(href)));
    }
  };

  // ⌘A selects the page, not the whole window.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey && e.key.toLowerCase() === "a" && !e.shiftKey && !e.altKey && page.current) {
      e.preventDefault();
      getSelection()?.selectAllChildren(page.current);
    }
  };

  return (
    <div ref={props.scrollRef} className={`markdown-view${props.hidden ? " hidden" : ""}`} tabIndex={-1} onClick={onClick} onKeyDown={onKeyDown}>
      <article ref={page} className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

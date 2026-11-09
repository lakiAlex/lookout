// Markdown files are shown as a page in their tab (see EditorView). The text
// is turned into HTML with marked and cleaned with DOMPurify: HTML in a
// Markdown file can not run scripts or style the app.
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { convertFileSrc } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { Marked } from "marked";

export const isMarkdown = (path: string) => /\.(md|markdown|mdown|mkd)$/i.test(path);

/** A URL with a scheme (https:, mailto:, data:) or a protocol-relative one. */
export const isUrl = (href: string) => /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href);

/** `rel` resolved against the folder `dir`. */
export function resolvePath(dir: string, rel: string): string {
  const out: string[] = [];
  for (const part of (rel.startsWith("/") ? rel : `${dir}/${rel}`).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** A link's path without its #part or ?query, with %20 and the like decoded. */
export function linkPath(href: string): string {
  const path = href.split(/[?#]/)[0];
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

const marked = new Marked({ gfm: true });

/** The folder of the file being rendered, for the image hook below. */
let base = "/";

/** A local image loads through Tauri's asset protocol (the open folder is allowed, see watch_folder). */
const imageUrl = (src: string) => (isUrl(src) || src.startsWith("#") ? src : convertFileSrc(resolvePath(base, linkPath(src))));

// Image paths are rewritten after DOMPurify has checked them, since it does not allow asset: URLs.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  const src = node.getAttribute("src");
  if (node.tagName === "IMG" && src) node.setAttribute("src", imageUrl(src));
  const srcset = node.getAttribute("srcset");
  if (srcset && (node.tagName === "SOURCE" || node.tagName === "IMG")) {
    node.setAttribute(
      "srcset",
      srcset
        .split(",")
        .map((candidate) => {
          const [url, ...size] = candidate.trim().split(/\s+/);
          return [imageUrl(url), ...size].join(" ");
        })
        .join(", "),
    );
  }
});

/** The HTML for a Markdown file's text. `dir` is the file's folder. */
export function renderMarkdown(text: string, dir: string): string {
  base = dir;
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form"], FORBID_ATTR: ["style"] });
}

/** Gives headings ids as GitHub does, so #links to them work. */
export function addHeadingIds(root: HTMLElement) {
  const seen = new Map<string, number>();
  for (const heading of root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
    const slug = (heading.textContent ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    heading.id = count ? `${slug}-${count}` : slug;
  }
}

/** Colors the code blocks that name their language, with the editor's parsers.
 * Stops when `current` turns false, after the page changed. */
export async function highlightCodeBlocks(root: HTMLElement, current: () => boolean) {
  for (const code of root.querySelectorAll<HTMLElement>("pre > code[class*='language-']")) {
    const name = /language-(\S+)/.exec(code.className)?.[1];
    const description = name ? LanguageDescription.matchLanguageName(languages, name, true) : null;
    if (!description) continue;
    const support = await description.load().catch(() => null);
    if (!current()) return;
    if (!support) continue;
    const text = code.textContent ?? "";
    const out = document.createDocumentFragment();
    highlightCode(
      text,
      support.language.parser.parse(text),
      classHighlighter,
      (part, classes) => {
        if (!classes) return out.append(part);
        const span = document.createElement("span");
        span.className = classes;
        span.textContent = part;
        out.append(span);
      },
      () => out.append("\n"),
    );
    code.replaceChildren(out);
  }
}

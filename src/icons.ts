// File and folder icons from "Icons - Maintained" (VS Code extension
// yusifaliyevpro.vscicons, MIT), see src/assets/vscicons/SOURCE.txt. Matched
// the way VS Code does: exact file name, then the longest extension, then the
// file's language. Folders by exact name, with open variants.
import manifest from "./assets/vscicons/icons.json";

type IconMap = Record<string, string>;

interface IconTheme {
  iconDefinitions: Record<string, { iconPath: string }>;
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileNames?: IconMap;
  fileExtensions?: IconMap;
  folderNames?: IconMap;
  folderNamesExpanded?: IconMap;
  languageIds?: IconMap;
}

const urls = import.meta.glob<string>("./assets/vscicons/icons/*.svg", {
  query: "?no-inline",
  import: "default",
  eager: true,
});

// VS Code picks many icons through a file's language; these are its built-in
// language ids for common extensions.
const LANGUAGE_BY_EXTENSION: IconMap = {
  php: "php", phtml: "php", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact", json: "json", jsonc: "jsonc",
  md: "markdown", markdown: "markdown", html: "html", htm: "html", css: "css", scss: "scss", sass: "sass",
  less: "less", yml: "yaml", yaml: "yaml", xml: "xml", py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", sql: "sql", ini: "ini", toml: "toml",
  twig: "twig", vue: "vue", svelte: "svelte", lua: "lua", pl: "perl", txt: "plaintext", graphql: "graphql",
};

const theme = manifest as unknown as IconTheme;
const lower = (map: IconMap = {}): IconMap => Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
const byFile: IconMap = Object.fromEntries(Object.entries(urls).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1), url]));
const urlById: IconMap = {};
for (const [id, def] of Object.entries(theme.iconDefinitions)) {
  const url = byFile[def.iconPath.slice(def.iconPath.lastIndexOf("/") + 1)];
  if (url) urlById[id] = url;
}
const names = lower(theme.fileNames);
const extensions = lower(theme.fileExtensions);
const folders = lower(theme.folderNames);
const foldersOpen = lower(theme.folderNamesExpanded);
const languages = theme.languageIds ?? {};

/** The icon image URL for a file, or for a folder (open or closed). */
export function iconUrl(name: string, dir: boolean, open = false): string {
  const key = name.toLowerCase();
  let id: string | undefined;
  if (dir) {
    id = open ? (foldersOpen[key] ?? theme.folderExpanded) : (folders[key] ?? theme.folder);
  } else {
    id = names[key];
    const parts = key.split(".");
    // "app.blade.php" tries "blade.php", then "php". ".env" tries "env".
    for (let i = 1; !id && i < parts.length; i++) id = extensions[parts.slice(i).join(".")];
    const language = parts.length > 1 ? LANGUAGE_BY_EXTENSION[parts[parts.length - 1]] : undefined;
    id = id ?? (language ? languages[language] : undefined) ?? theme.file;
  }
  return (id && urlById[id]) || urlById[(dir ? theme.folder : theme.file) ?? ""] || "";
}

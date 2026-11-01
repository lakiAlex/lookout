// Sidebar icons, from Hugeicons like the rest of the app. The open panel's icon is drawn bolder.
import { Files02Icon, FolderOpenIcon, GitBranchIcon, CursorMagicSelection02Icon, Search01Icon, Settings02Icon, SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const ICONS = {
  files: Files02Icon,
  search: Search01Icon,
  git: GitBranchIcon,
  pick: CursorMagicSelection02Icon,
  folder: FolderOpenIcon,
  settings: Settings02Icon,
  sidebar: SidebarLeftIcon,
};

export type SidebarIconName = keyof typeof ICONS;

export function SidebarIcon({ name, filled = false, size = 24 }: { name: SidebarIconName; filled?: boolean; size?: number }) {
  return <HugeiconsIcon icon={ICONS[name]} size={size} strokeWidth={filled ? 2 : 1.6} />;
}

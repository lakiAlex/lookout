// Sidebar icons, from Hugeicons like the rest of the app. The open panel's icon is drawn bolder.
import { File02Icon, Folder03Icon, GitGraphIcon, CursorMagicSelection04Icon, Search01Icon, MoreHorizontalIcon, SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const ICONS = {
  files: File02Icon,
  search: Search01Icon,
  git: GitGraphIcon,
  pick: CursorMagicSelection04Icon,
  folder: Folder03Icon,
  settings: MoreHorizontalIcon,
  sidebar: SidebarLeftIcon,
};

export type SidebarIconName = keyof typeof ICONS;

export function SidebarIcon({ name, filled = false, size = 24 }: { name: SidebarIconName; filled?: boolean; size?: number }) {
  return <HugeiconsIcon icon={ICONS[name]} size={size} strokeWidth={filled ? 2 : 1.6} />;
}

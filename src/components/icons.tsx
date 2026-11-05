// The app's icons: Hugeicons stroke-rounded (MIT, https://hugeicons.com), under the
// names the components use. The title bar's terminal glyph stays Lucide, since it
// matches the app icon.
import {
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowRight01Icon,
  ArrowShrink02Icon,
  ArrowUpRight01Icon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  AtIcon,
  BrowserIcon,
  Cancel01Icon,
  CancelCircleIcon,
  CaseSensitiveIcon,
  CatIcon,
  ClaudeIcon,
  CheckmarkCircle02Icon,
  CleanIcon,
  ClipboardIcon,
  ColorsIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  CursorTextIcon,
  Delete02Icon,
  File01Icon,
  FileAddIcon,
  GitCommitIcon,
  FolderAddIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitCompareIcon,
  GitGraphIcon,
  HistoryIcon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  LinkSquare02Icon,
  ServerStack02Icon,
  CommandIcon,
  KeyboardIcon,
  Loading03Icon,
  Login01Icon,
  MessageNotification01Icon,
  MinusSignIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  NotificationSquareIcon,
  OptionIcon,
  ParagraphSpacingIcon,
  PaintBoardIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  RefreshIcon,
  RegexIcon,
  ScrollIcon,
  SourceCodeIcon,
  SparklesIcon,
  Sun03Icon,
  TextFontIcon,
  TextIcon,
  TextSelectionIcon,
  TextWrapIcon,
  Tick02Icon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export { Terminal } from "lucide-react";

interface IconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

function icon(svg: IconSvgElement) {
  return function Icon({ size = 16, strokeWidth = 1.7, className }: IconProps) {
    return <HugeiconsIcon icon={svg} size={size} strokeWidth={strokeWidth} className={className} />;
  };
}

export const ALargeSmall = icon(TextFontIcon);
export const ArrowDown = icon(ArrowDown02Icon);
export const ArrowUp = icon(ArrowUp02Icon);
export const AtSign = icon(AtIcon);
export const AppWindow = icon(BrowserIcon);
export const Bell = icon(NotificationSquareIcon);
export const BrushCleaning = icon(CleanIcon);
export const CaseSensitive = icon(CaseSensitiveIcon);
export const Cat = icon(CatIcon);
export const Check = icon(Tick02Icon);
export const Claude = icon(ClaudeIcon);
export const CircleCheck = icon(CheckmarkCircle02Icon);
export const CircleX = icon(CancelCircleIcon);
export const LogIn = icon(Login01Icon);
export const MessageBell = icon(MessageNotification01Icon);
export const ChevronDown = icon(ArrowDown01Icon);
export const ChevronRight = icon(ArrowRight01Icon);
export const ChevronUp = icon(ArrowUp01Icon);
export const ClipboardCopy = icon(ClipboardIcon);
export const Colors = icon(ColorsIcon);
export const Code = icon(SourceCodeIcon);
export const Copy = icon(Copy01Icon);
export const Ellipsis = icon(MoreHorizontalIcon);
export const GitCommit = icon(GitCommitIcon);
export const FilePlus2 = icon(FileAddIcon);
export const FileText = icon(File01Icon);
export const FolderOpen = icon(FolderOpenIcon);
export const FolderPlus = icon(FolderAddIcon);
export const GitBranch = icon(GitBranchIcon);
export const GitCompare = icon(GitCompareIcon);
export const GitGraph = icon(GitGraphIcon);
export const History = icon(HistoryIcon);
export const Split = icon(LayoutTwoColumnIcon);
export const SplitDown = icon(LayoutTwoRowIcon);
export const MoveOut = icon(ArrowUpRight01Icon);
export const ExternalLink = icon(LinkSquare02Icon);
export const Server = icon(ServerStack02Icon);
export const Command = icon(CommandIcon);
export const ListCollapse = icon(ArrowShrink02Icon);
export const Keyboard = icon(KeyboardIcon);
export const LoaderCircle = icon(Loading03Icon);
export const Minus = icon(MinusSignIcon);
export const Moon = icon(Moon02Icon);
export const Option = icon(OptionIcon);
export const Palette = icon(PaintBoardIcon);
export const Pencil = icon(PencilEdit02Icon);
export const Plus = icon(PlusSignIcon);
export const RefreshCw = icon(RefreshIcon);
export const Regex = icon(RegexIcon);
export const Rows3 = icon(ParagraphSpacingIcon);
export const ScrollText = icon(ScrollIcon);
export const Sparkle = icon(SparklesIcon);
export const SquareTerminal = icon(ComputerTerminal01Icon);
export const Sun = icon(Sun03Icon);
export const TextCursor = icon(CursorTextIcon);
export const TextWrap = icon(TextWrapIcon);
export const Trash2 = icon(Delete02Icon);
export const Type = icon(TextIcon);
export const Undo2 = icon(Undo02Icon);
export const WholeWord = icon(TextSelectionIcon);
export const X = icon(Cancel01Icon);

import {
  AiBrain01Icon as AiBrain01,
  ArchiveArrowDownIcon as ArchiveArrowDown,
  LoginSquare01Icon as LoginSquare01,
  LogoutSquare01Icon as LogoutSquare01,
  Activity01Icon as Activity01,
  CornerDownLeftIcon as CornerDownLeft,
  InboxIcon as InboxTray,
  Add01Icon as Add01,
  AlarmClockIcon as AlarmClock,
  Alert02Icon as Alert02,
  AlertCircleIcon as AlertCircle,
  ArrowDown01Icon as ArrowDown01,
  ArrowDown02Icon as ArrowDown02,
  ArrowDownToLineIcon as ArrowDownToLine,
  ArrowExpand01Icon as ArrowExpand01,
  ArrowLeft01Icon as ArrowLeft01,
  ArrowLeft02Icon as ArrowLeft02,
  ArrowRight01Icon as ArrowRight01,
  ArrowRight02Icon as ArrowRight02,
  ArrowRightToLineIcon as ArrowRightToLine,
  ArrowShrink02Icon as ArrowShrink02,
  ArrowUp01Icon as ArrowUp01,
  ArrowUp02Icon as ArrowUp02,
  ArrowUpDownIcon as ArrowUpDown,
  ArrowUpRight01Icon as ArrowUpRight01,
  AtSignIcon as AtSign,
  BellIcon as Bell,
  BellOffIcon as BellOff,
  BellPlusIcon as BellPlus,
  BellRingIcon as BellRing,
  Bookmark02Icon as Bookmark02,
  BookmarkRemove02Icon as BookmarkRemove02,
  BotIcon as Bot,
  CalendarClockIcon as CalendarClock,
  Camera01Icon as Camera01,
  Cancel01Icon as Cancel01,
  CancelCircleIcon as CancelCircle,
  CheckmarkCircle02Icon as CheckmarkCircle02,
  CircleIcon as Circle,
  ClipboardCopyIcon as ClipboardCopy,
  Clock01Icon as Clock01,
  CodeSimpleIcon as CodeSimple,
  ComputerIcon as Computer,
  Copy01Icon as Copy01,
  CpuIcon as Cpu,
  CursorInWindowIcon as CursorInWindow,
  Delete02Icon as Delete02,
  Download01Icon as Download01,
  DragDropVerticalIcon as DragDropVertical,
  EraserIcon as Eraser,
  File01Icon as File01,
  File02Icon as File02,
  DocumentAttachmentIcon as DocumentAttachment,
  FilterHorizontalIcon as FilterHorizontal,
  FloppyDiskIcon as FloppyDisk,
  Folder01Icon as Folder01,
  FolderEditIcon as FolderEdit,
  Folder02Icon as Folder02,
  Globe02Icon as Globe02,
  HashIcon as Hash,
  HistoryIcon as History,
  HourglassIcon as Hourglass,
  IdCardIcon as IdCard,
  Image01Icon as Image01,
  InformationCircleIcon as InformationCircle,
  Layers01Icon as Layers01,
  Link01Icon as Link01,
  LinkSquare02Icon as LinkSquare02,
  Message01Icon as Message01,
  Message02Icon as Message02,
  MoreHorizontalIcon as MoreHorizontal,
  MoreVerticalIcon as MoreVertical,
  PaintBoardIcon as PaintBoard,
  PanelLeftCloseIcon as PanelLeftClose,
  PanelLeftOpenIcon as PanelLeftOpen,
  PenLineIcon as PenLine,
  PencilEdit02Icon as PencilEdit02,
  PlayIcon as Play,
  Plug01Icon as Plug01,
  PowerIcon as Power,
  QuoteDownIcon as QuoteDown,
  Redo02Icon as Redo02,
  RefreshIcon as Refresh,
  ReloadIcon as Reload,
  RepeatIcon as Repeat,
  Search01Icon as Search01,
  ServerIcon as Server,
  Settings01Icon as Settings01,
  Settings05Icon as Settings05,
  Share03Icon as Share03,
  Share08Icon as Share08,
  ShieldCheckIcon as ShieldCheck,
  ShieldOffIcon as ShieldOff,
  SmilePlusIcon as SmilePlus,
  SourceCodeIcon as SourceCode,
  SproutIcon as Sprout,
  SquareLock02Icon as SquareLock02,
  SquareUnlock02Icon as SquareUnlock02,
  StarIcon as Star,
  TerminalIcon as Terminal,
  TextFontIcon as TextFont,
  TextQuoteIcon as TextQuote,
  Tick02Icon as Tick02,
  Timer02Icon as Timer02,
  UnavailableIcon as Unavailable,
  Undo02Icon as Undo02,
  Unlink01Icon as Unlink01,
  UnplugIcon as Unplug,
  UserIcon as User,
  UserAdd01Icon as UserAdd01,
  UserMinus01Icon as UserMinus01,
  UsersRoundIcon as UsersRound,
  ViewIcon as View,
  ViewOffSlashIcon as ViewOffSlash,
  WorkflowIcon as Workflow,
  Wrench01Icon as Wrench01,
  ZoomInIcon as ZoomIn,
  ZoomOutIcon as ZoomOut,
} from "@hugeicons/core-free-icons";
import { createIcon, type IconNode } from "./icon";

const icon = (name: string, node: unknown) => createIcon(name, node as IconNode);

export const ActivityIcon = icon("activity", Activity01);
export const AddMemberIcon = icon("add-member", UserAdd01);
export const AddReactionIcon = icon("add-reaction", SmilePlus);
export const AlarmIcon = icon("alarm", AlarmClock);
export const AppearanceIcon = icon("appearance", PaintBoard);
export const ArrowDownIcon = icon("arrow-down", ArrowDown02);
export const ArrowDownToLineIcon = icon("arrow-down-to-line", ArrowDownToLine);
export const ArrowLeftIcon = icon("arrow-left", ArrowLeft02);
export const ArrowRightIcon = icon("arrow-right", ArrowRight02);
export const ArrowRightToLineIcon = icon("arrow-right-to-line", ArrowRightToLine);
export const ArrowUpIcon = icon("arrow-up", ArrowUp02);
export const ArrowUpRightIcon = icon("arrow-up-right", ArrowUpRight01);
export const AttachmentIcon = icon("attachment", DocumentAttachment);
export const BellIcon = icon("bell", Bell);
export const BellOffIcon = icon("bell-off", BellOff);
export const BellRingIcon = icon("bell-ring", BellRing);
export const BellPlusIcon = icon("bell-plus", BellPlus);
export const BookmarkIcon = icon("bookmark", Bookmark02);
export const BookmarkRemoveIcon = icon("bookmark-remove", BookmarkRemove02);
export const BotIcon = icon("bot", Bot);
export const CameraIcon = icon("camera", Camera01);
export const CancelledIcon = icon("cancelled", Unavailable);
export const CheckIcon = icon("check", Tick02);
export const ChevronDownIcon = icon("chevron-down", ArrowDown01);
export const ChevronLeftIcon = icon("chevron-left", ArrowLeft01);
export const ChevronRightIcon = icon("chevron-right", ArrowRight01);
export const ChevronUpIcon = icon("chevron-up", ArrowUp01);
export const CircleIcon = icon("circle", Circle);
export const ClearIcon = icon("clear", Eraser);
export const ClockIcon = icon("clock", Clock01);
export const CloseIcon = icon("close", Cancel01);
export const CodeFontIcon = icon("code-font", SourceCode);
export const CodeIcon = icon("code", CodeSimple);
export const CollapseIcon = icon("collapse", ArrowShrink02);
export const ComputerIcon = icon("computer", Computer);
export const CopyIcon = icon("copy", Copy01);
export const CopyMarkdownIcon = icon("copy-markdown", ClipboardCopy);
export const CpuIcon = icon("cpu", Cpu);
export const CreatedByIcon = icon("created-by", PenLine);
export const DeleteIcon = icon("delete", Delete02);
export const DiagramIcon = icon("diagram", Workflow);
export const DisconnectedIcon = icon("disconnected", Unplug);
export const DocumentIcon = icon("document", File02);
export const DownloadIcon = icon("download", Download01);
export const DragHandleIcon = icon("drag-handle", DragDropVertical);
export const EditIcon = icon("edit", PencilEdit02);
export const EnterIcon = icon("enter", CornerDownLeft);
/** An empty list or collection: an empty tray. */
export const EmptyIcon = icon("empty", InboxTray);
export const ErrorIcon = icon("error", AlertCircle);
export const ExpandIcon = icon("expand", ArrowExpand01);
export const FailedIcon = icon("failed", CancelCircle);
export const FileIcon = icon("file", File01);
export const FiltersIcon = icon("filters", FilterHorizontal);
export const FolderEditIcon = icon("folder-edit", FolderEdit);
export const FolderIcon = icon("folder", Folder01);
export const FolderOpenIcon = icon("folder-open", Folder02);
export const FontIcon = icon("font", TextFont);
export const GeneralSettingsIcon = icon("general-settings", Settings05);
export const GlobeIcon = icon("globe", Globe02);
export const HashIcon = icon("hash", Hash);
export const HistoryIcon = icon("history", History);
export const ImageIcon = icon("image", Image01);
export const InboxIcon = icon("inbox", ArchiveArrowDown);
export const InfoIcon = icon("info", InformationCircle);
export const IntegrationIcon = icon("integration", Plug01);
export const JoinIcon = icon("join", LoginSquare01);
export const LayersIcon = icon("layers", Layers01);
export const LeaveIcon = icon("leave", LogoutSquare01);
export const LinkIcon = icon("link", Link01);
export const LockIcon = icon("lock", SquareLock02);
export const MembersIcon = icon("members", UsersRound);
export const MentionIcon = icon("mention", AtSign);
export const MessageIcon = icon("message", Message01);
/**
 * The Thread entity, on every thread surface: the single bubble. The compound
 * `ChatsIcon` names chat sections and is never a thread.
 */
export const ThreadIcon = icon("thread", Message01);
export const MessageResultIcon = icon("message-result", Message02);
export const MoreIcon = icon("more", MoreHorizontal);
export const MoreVerticalIcon = icon("more-vertical", MoreVertical);
export const OpenExternalIcon = icon("open-external", LinkSquare02);
export const PlayIcon = icon("play", Play);
export const PlusIcon = icon("plus", Add01);
export const PowerIcon = icon("power", Power);
export const ProfileCardIcon = icon("profile-card", IdCard);
export const QuoteIcon = icon("quote", QuoteDown);
export const QuoteSelectionIcon = icon("quote-selection", TextQuote);
export const RefreshIcon = icon("refresh", Refresh);
export const ReloadIcon = icon("reload", Reload);
export const RemoveMemberIcon = icon("remove-member", UserMinus01);
export const RepeatIcon = icon("repeat", Repeat);
export const RetryIcon = icon("retry", Redo02);
export const SaveIcon = icon("save", FloppyDisk);
export const ScheduledIcon = icon("scheduled", CalendarClock);
export const SearchIcon = icon("search", Search01);
export const SelectTextIcon = icon("select-text", CursorInWindow);
export const ServerIcon = icon("server", Server);
export const SettingsIcon = icon("settings", Settings01);
export const ShareIcon = icon("share", Share03);
export const ShareLinkIcon = icon("share-link", Share08);
export const ShieldCheckIcon = icon("shield-check", ShieldCheck);
export const ShieldOffIcon = icon("shield-off", ShieldOff);
export const SidebarCloseIcon = icon("sidebar-close", PanelLeftClose);
export const SidebarOpenIcon = icon("sidebar-open", PanelLeftOpen);
export const SortIcon = icon("sort", ArrowUpDown);
export const SpawnedIcon = icon("spawned", Sprout);
export const StarIcon = icon("star", Star);
export const SuccessIcon = icon("success", CheckmarkCircle02);
export const TerminalIcon = icon("terminal", Terminal);
export const ThinkingIcon = icon("thinking", AiBrain01);
export const TimerIcon = icon("timer", Timer02);
export const ToolIcon = icon("tool", Wrench01);
export const UndoIcon = icon("undo", Undo02);
export const UnlinkIcon = icon("unlink", Unlink01);
export const UnlockIcon = icon("unlock", SquareUnlock02);
export const UserIcon = icon("user", User);
export const ViewIcon = icon("view", View);
export const ViewOffIcon = icon("view-off", ViewOffSlash);
export const WaitingIcon = icon("waiting", Hourglass);
export const WarningIcon = icon("warning", Alert02);
export const ZoomInIcon = icon("zoom-in", ZoomIn);
export const ZoomOutIcon = icon("zoom-out", ZoomOut);

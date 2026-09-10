import { type ComponentType, type SVGProps } from "react";
import { Activity, AlarmClock, FolderTree, MessagesSquare, Plug, User } from "lucide-react";
import { cn } from "@/lib/cn";

export type AgentSection = "profile" | "workspace" | "mcp" | "activity" | "schedules" | "chats";

interface SectionItem {
  id: AgentSection;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  hint: string;
  /** Owner-only sections are hidden entirely for non-owners — not shown with a
   *  "private" state. The Chats audit face is an explicit privacy capability, so
   *  its very existence is not advertised to a non-owner (unlike Workspace files,
   *  which show a neutral private placeholder). */
  ownerOnly?: boolean;
}

export const AGENT_SECTIONS: ReadonlyArray<SectionItem> = [
  {
    id: "profile",
    label: "Profile",
    icon: User,
    hint: "Identity, runtime, model.",
  },
  {
    id: "schedules",
    label: "Schedules",
    icon: AlarmClock,
    hint: "Cron / interval / one-shot wakeups.",
  },
  {
    id: "chats",
    label: "Chats",
    icon: MessagesSquare,
    hint: "Owner-only, read-only audit of this agent’s conversations.",
    ownerOnly: true,
  },
  {
    id: "workspace",
    label: "Workspace",
    icon: FolderTree,
    hint: "L1 system prompt, MEMORY, notes.",
  },
  {
    id: "mcp",
    label: "MCP",
    icon: Plug,
    hint: "Profile MCP servers — raw config + summary.",
  },
  {
    id: "activity",
    label: "Activity",
    icon: Activity,
    hint: "Per-channel execution trace.",
  },
];

export function AgentSectionTabs<T extends string>({
  sections,
  active,
  onChange,
}: {
  sections: readonly {
    id: T;
    label: string;
    icon: ComponentType<SVGProps<SVGSVGElement>>;
    hint?: string;
  }[];
  active: T;
  onChange: (section: T) => void;
}): JSX.Element {
  return (
    <nav aria-label="Agent sections" className="agent-section-tabs scrollbar-hide">
      {sections.map((item) => {
        const selected = item.id === active;
        const Icon = item.icon;

        return (
          <button
            key={item.id}
            type="button"
            aria-current={selected ? "page" : undefined}
            onClick={() => onChange(item.id)}
            title={item.hint}
            className={cn("agent-section-tab", selected && "agent-section-tab-selected")}
          >
            <Icon className="size-3.5 shrink-0" strokeWidth={selected ? 2.25 : 2} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

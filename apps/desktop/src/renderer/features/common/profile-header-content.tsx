import type { CSSProperties, ReactNode } from "react";
import { AVATAR_PX } from "@/components/avatar-scale";
import "@/features/agents/agent-page.css";

export function ProfileHeaderContent({
  compact,
  avatar,
  displayName,
  status,
  description,
  actions,
}: {
  compact: boolean;
  avatar: ReactNode;
  displayName: string;
  status?: ReactNode;
  description?: string | null;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div
      className="agent-header-content"
      data-compact={compact}
      style={
        {
          "--agent-header-avatar-size": `${compact ? AVATAR_PX.md : AVATAR_PX.xl}px`,
        } as CSSProperties
      }
    >
      <div className="shrink-0">{avatar}</div>
      <div className="agent-header-identity">
        <div className="agent-header-name-row">
          <span className="agent-header-name" title={displayName}>
            {displayName}
          </span>
          {status}
        </div>
        {description?.trim() ? (
          <p className="agent-header-description" title={description}>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div data-channel-actions={compact ? "" : undefined} className="agent-header-actions">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

import type { JSX, MouseEvent, ReactNode } from "react";
import { getPlatform } from "@/platform";
import { cn } from "@/lib/cn";

/** Fixed to the hosted service: the policy covers that service, whichever server the app is on. */
export const PRIVACY_POLICY_URL = "https://silverhand.build/privacy";
export const SUPPORT_URL = "https://silverhand.build/support";

/** A real link (copyable, announced as one) that the host opens in the system browser. */
export function ExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void getPlatform().files.openExternal(href);
  };

  return (
    <a href={href} onClick={open} className={cn("focus-outline", className)}>
      {children}
    </a>
  );
}

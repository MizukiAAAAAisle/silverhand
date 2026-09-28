import type { ReactNode } from "react";
import { Brandmark } from "./brandmark";

/** 50/50 shell shared by the auth gate and the profile-setup step: brand on
 *  the left, form on the right. Below `lg` the brand half is hidden and the
 *  form fills the width. */
export function AuthSplitLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <main
      className="flex h-screen w-screen bg-bg-base text-text-primary"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <BrandPanel />
      <div className="grid w-full place-items-center px-6 py-14 min-[860px]:w-1/2">{children}</div>
    </main>
  );
}

const ISO_GRID =
  "repeating-linear-gradient(30deg, var(--border-subtle) 0 1px, transparent 1px 88px)," +
  "repeating-linear-gradient(150deg, var(--border-subtle) 0 1px, transparent 1px 88px)," +
  "repeating-linear-gradient(90deg, var(--border-subtle) 0 1px, transparent 1px 152px)";

function BrandPanel(): JSX.Element {
  return (
    <section
      aria-hidden
      className="relative hidden w-1/2 shrink-0 overflow-hidden bg-bg-inset min-[860px]:block"
    >
      <div className="absolute inset-0 opacity-70" style={{ backgroundImage: ISO_GRID }} />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-1/3"
        style={{ background: "linear-gradient(to bottom, var(--bg-inset), transparent)" }}
      />
      <Brandmark className="absolute -bottom-24 -right-20 size-[34rem] text-text-primary opacity-[0.04]" />
      <div className="absolute inset-0 grid place-items-center p-12">
        <div className="flex max-w-md flex-col gap-8">
          <Brandmark className="size-16 text-text-primary" />
          <div className="flex flex-col gap-3">
            <h2 className="text-4xl font-semibold leading-none tracking-tight">Silverhand</h2>
            <p className="text-base leading-relaxed text-text-muted">
              Where humans and agents work together.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

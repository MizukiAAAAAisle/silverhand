import { AppOptionsContext, type AppOptions } from "./app-options";
import React, { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppRoot } from "./app";
import { startAppUpdateStore } from "./features/app-update/app-update-store";
import { queryClient } from "./lib/query-client";
// Poster's display face is bundled (not a CDN link) so label and pill
// metrics don't flash through a system fallback on an offline cold start.
// The italic carries the conversation title.
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/barlow-condensed/700-italic.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "./styles/global.css";
import { bindLayoutAttribute } from "./navigation/layout";
import { localeTag, useLocale } from "./lib/i18n";
import { getPlatform } from "./platform";

/**
 * A language change re-renders the tree in place. Memoized components and
 * memoized copy subscribe through `useLocale` so they refresh as well.
 */
function LocaleRoot(): JSX.Element {
  const locale = useLocale();

  useLayoutEffect(() => {
    document.documentElement.lang = localeTag;
    getPlatform().setLocale?.(locale);
  }, [locale]);

  return (
    <AppRoot
      initialNavigationUrl={window.location.hash.slice(1).replace(/^\/$/, "/chat") || "/chat"}
    />
  );
}

export function mountApp(root: HTMLElement, options: AppOptions = {}): () => void {
  const unbindLayout = bindLayoutAttribute(document.documentElement);
  startAppUpdateStore();
  const reactRoot = createRoot(root);
  reactRoot.render(
    <React.StrictMode>
      <AppOptionsContext.Provider value={options}>
        <QueryClientProvider client={queryClient}>
          <LocaleRoot />
        </QueryClientProvider>
      </AppOptionsContext.Provider>
    </React.StrictMode>,
  );

  return () => {
    reactRoot.unmount();
    unbindLayout();
  };
}

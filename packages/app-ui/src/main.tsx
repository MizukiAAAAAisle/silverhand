import { AppOptionsContext, type AppOptions } from "./app-options";
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app";
import { queryClient } from "./lib/query-client";
// Rajdhani is forza6's tech/racing display face — bundled (not a CDN
// link) so chrome label / task pill / sidebar count metrics don't
// flash through a system fallback during a cold start with no network.
// Single weight (700) only, ~16KB woff2.
import "@fontsource/rajdhani/700.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "./styles/global.css";
import { bindLayoutAttribute } from "./navigation/layout";

export function mountApp(root: HTMLElement, options: AppOptions = {}): () => void {
  const unbindLayout = bindLayoutAttribute(document.documentElement);
  const reactRoot = createRoot(root);
  reactRoot.render(
    <React.StrictMode>
      <AppOptionsContext.Provider value={options}>
        <QueryClientProvider client={queryClient}>
          <App
            initialNavigationUrl={window.location.hash.slice(1).replace(/^\/$/, "/chat") || "/chat"}
          />
        </QueryClientProvider>
      </AppOptionsContext.Provider>
    </React.StrictMode>,
  );

  return () => {
    reactRoot.unmount();
    unbindLayout();
  };
}

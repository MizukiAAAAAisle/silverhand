import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { App } from "./App";
import { queryClient } from "./lib/queryClient";
// Rajdhani is forza6's tech/racing display face — bundled (not a CDN
// link) so chrome label / task pill / sidebar count metrics don't
// flash through a system fallback during a cold start with no network.
// Single weight (700) only, ~16KB woff2.
import "@fontsource/rajdhani/700.css";
// Space Grotesk — forza6's body / sidebar face. shiki picked it over
// Inter (msg NklHz_M9fnIuJ6P7: "Inter 太普通了，还是改回 Space Grotesk")
// so the conversation pane and both sidebars carry the brand
// identity. 400/500/600/700 cover prose, bylines, button weights.
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
// Space Mono — forza6's sigil/code face. 400/700 cover inline `code`,
// task sigils (#NNN), MessageTaskTag claim chips, etc.
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          {/* Catch-all keeps App mounted across all navigations so its
              refs (lastSessionByChannel) and dialog state survive route
              changes. App reads URL params via useRouteState (useMatch
              under the hood — works fine without nested Route defs). */}
          <Route path="*" element={<App />} />
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);

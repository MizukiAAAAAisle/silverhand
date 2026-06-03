import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { App } from './App';
import { queryClient } from './lib/queryClient';
// Rajdhani is forza6's tech/racing display face — bundled (not a CDN
// link) so chrome label / task pill / sidebar count metrics don't
// flash through a system fallback during a cold start with no network.
// Single weight (700) only, ~16KB woff2.
import '@fontsource/rajdhani/700.css';
// Space Grotesk / Space Mono — forza6's body / sigil pair, locked in
// shiki's font-optimization ask (msg iNP_JRK8OH6D1L7q). Bundled the same
// way as Rajdhani so chrome doesn't flash through system-ui during cold
// starts with no network. Grotesk: 400/500/600/700 cover prose, button
// weights, message bylines, agent names. Mono: 400/700 cover inline
// `code`, task sigils (#NNN), TaskMetaTag claim chips, etc.
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/space-mono/400.css';
import '@fontsource/space-mono/700.css';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

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

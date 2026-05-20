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
// Barlow Condensed is forza6's prose-poster face for the markdown task
// chip (`--forza6-font-task-ref`, #task:494). Deliberately separate
// from `--font-display` so chrome-label font trials don't drag the
// inline-in-prose chip with them. Single weight (700) only, ~18KB woff2.
import '@fontsource/barlow-condensed/700.css';
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

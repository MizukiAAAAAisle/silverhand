import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { App } from './App';
import { queryClient } from './lib/queryClient';
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

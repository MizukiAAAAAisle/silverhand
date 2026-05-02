import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { EventsApp } from './EventsApp';
import { queryClient } from '@/lib/queryClient';
import '@/styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <EventsApp />
    </QueryClientProvider>
  </React.StrictMode>,
);

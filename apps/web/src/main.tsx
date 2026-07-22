import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationBell } from './components/NotificationBell';

const queryClient = new QueryClient();

function Navbar(): React.ReactElement {
  return (
    <header className="fixed top-0 inset-x-0 h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6 z-40">
      <span className="text-sm font-semibold text-gray-700">Ensemb</span>
      <NotificationBell />
    </header>
  );
}

function App(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <Navbar />
      <main className="pt-14 p-6">
        <p className="text-sm text-gray-500">Ensemb — ERP/POS SaaS</p>
      </main>
    </QueryClientProvider>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(<App />);

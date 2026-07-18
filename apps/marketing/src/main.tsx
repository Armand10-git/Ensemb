import React from 'react';
import { createRoot } from 'react-dom/client';

function App(): React.ReactElement {
  return <div>Ensemb — Marketing</div>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(<App />);

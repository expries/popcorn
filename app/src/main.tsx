import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './providers';

const rootElement = document.querySelector('#root');

if (rootElement === null) {
  throw new Error('Failed to get root element');
}

if (import.meta.hot) {
  // With hot module reloading, `import.meta.hot.data` is persisted.
  const root = (import.meta.hot.data.root ??= createRoot(rootElement));
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} else {
  // The hot module reloading API is not available in production.
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

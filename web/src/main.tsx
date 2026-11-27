import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { watchTheme } from './theme';
import { Toasts } from './ui';
import './styles.css';
import './skeleton.css';
import './polish.css';
import './look.css';

watchTheme();

// Pause anything continuous while the tab is hidden.
const hidden = () => document.documentElement.toggleAttribute('data-hidden', document.hidden);
document.addEventListener('visibilitychange', hidden);
hidden();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Toasts>
      <App />
    </Toasts>
  </StrictMode>,
);

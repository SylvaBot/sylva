import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { watchTheme } from './theme';
import { Toasts } from './ui';
import './styles.css';

watchTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Toasts>
      <App />
    </Toasts>
  </StrictMode>,
);

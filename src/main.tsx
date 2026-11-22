import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { applyDocumentLocale } from './i18n/core';
import { useGameStore } from './store/useGameStore';

applyDocumentLocale(useGameStore.getState().language);

createRoot(document.getElementById('root')!).render(<App />);

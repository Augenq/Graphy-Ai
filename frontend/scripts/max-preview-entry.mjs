// Dedicated production preview. No provider requests or real user histories.
import { installMockBackend } from './mock-backend.mjs';
installMockBackend();
const { initBackend } = await import('/src/lib/backend.ts');
await initBackend();
await import('../src/material.ts');
await import('../src/index.css');
import.meta.glob(['../src/styles/*.css', '!../src/styles/mobile.css'], { eager: true });
await import('../src/styles/mobile.css');
const { initSettings, updateSettings } = await import('../src/lib/settings.ts');
initSettings();
const params = new URLSearchParams(location.search);
updateSettings({ theme: params.get('theme') === 'light' ? 'light' : 'dark', palette: params.get('palette') === 'max' ? 'max' : 'graphy' });
const { createElement, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: App } = await import('../src/App.tsx');
createRoot(document.getElementById('root')).render(createElement(StrictMode, null, createElement(App)));
window.__maxPreviewReady = true;

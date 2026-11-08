import { resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import config from '../vite.config.ts';
export default mergeConfig(config, defineConfig({ build: {
  outDir: 'dist-ui-preview',
  rollupOptions: { input: resolve(import.meta.dirname, '../max-preview.html') },
} }));

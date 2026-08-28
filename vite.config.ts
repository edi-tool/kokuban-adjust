import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * GitHub Pages (https://<user>.github.io/kokuban-adjust/) で
 * そのまま動くよう相対パスで出力する。
 */
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        lab: resolve(__dirname, 'dev/lab.html'),
      },
    },
  },
});

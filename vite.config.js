import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// Build stamp shown on the front page so you can confirm a deploy actually
// reached your device. The timestamp changes on every build, so if the version
// on your phone doesn't match a fresh build, it hasn't synced yet.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const BUILD_ID = `v${pkg.version}`;

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },

  // Serve assets from project root
  publicDir: 'public',

  // Worker format: ES modules
  worker: {
    format: 'es',
  },

  // Allow importing .wgsl files as raw text strings
  assetsInclude: ['**/*.wgsl', '**/*.cube'],

  // Don't pre-bundle libraw-wasm — its internal Web Worker is created via
  // `new Worker(new URL('./worker.js', import.meta.url))` and the wasm is
  // resolved relative to the module. Vite's dep optimizer rewrites those URLs
  // and breaks worker/wasm loading (decode hangs forever). Excluding it keeps
  // the package's own relative resolution intact.
  optimizeDeps: {
    exclude: ['libraw-wasm'],
  },

  build: {
    target: 'esnext',
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          // Keep libraw-wasm in its own chunk — it's large
          'libraw': ['libraw-wasm'],
        },
      },
    },
  },

  // NO COOP/COEP headers — matching production (public/_headers). The libraw
  // worker runs as a plain Web Worker without SharedArrayBuffer, and setting
  // them in dev only would hide a dev/prod difference (and COOP breaks iOS
  // standalone PWA launch in production).
});

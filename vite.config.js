import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    target: 'es2023',
    chunkSizeWarningLimit: 8192,
  },
  // .wgsl files are imported with ?raw — no plugin needed.
});

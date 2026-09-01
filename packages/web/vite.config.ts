import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Consume the shared package's TypeScript source rather than its
      // CommonJS build output. This keeps named exports statically
      // analysable for Rollup and enables proper tree-shaking.
      '@ipam/shared': fileURLToPath(
        new URL('../shared/src/index.ts', import.meta.url),
      ),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split the heavy grid and charting libraries into their own chunks so
        // the initial payload stays small and they cache independently.
        manualChunks: {
          'vendor-grid': ['ag-grid-community', 'ag-grid-react'],
          'vendor-charts': ['recharts'],
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-auth': ['oidc-client-ts', 'react-oidc-context'],
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});

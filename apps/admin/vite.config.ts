import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@hedge/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // Fail if 5173 is taken rather than sliding to 5174. The admin's own origin has to be one the
    // CMS trusts (`trustedOrigins` in `apps/api/src/auth/cms.ts`), and that list names 5173 by
    // number — a silent bump lands the dev server on an untrusted origin where every sign-in and
    // password reset is refused with "Invalid origin", which reads as a bug in the code under test.
    strictPort: true,
    // `wrangler dev` serves the Worker on 8787; proxy so the admin talks to a real API locally.
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/media': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Freebuff previews are reached through a generated host such as
    // 5173-<id>.e2b.app, which is not localhost. Vite 5.4 rejects any host
    // that is not on the allowlist ("Blocked request … not allowed"), so the
    // preview platform's domain has to be permitted explicitly. The leading
    // dot allows the domain itself and every *.e2b.app subdomain, so a new
    // preview with a different id keeps working without editing this file.
    allowedHosts: ['.e2b.app'],
  },
})

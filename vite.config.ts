import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Vite runs inside the Express server in development (middleware mode, see
// server.ts), so the bind address and port come from server.ts.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});

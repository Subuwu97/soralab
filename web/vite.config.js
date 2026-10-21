import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev: Vite on 5180 proxies to the SoraLab server (4800).
// Set PUBLIC_URL=http://localhost:5180 in server/.env while developing so sign-in returns here.
const target = process.env.SORALAB_API || 'http://localhost:4800';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // suite/web (the notification bell, install helpers) lives outside this folder.
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { chunkSizeWarningLimit: 4000, target: 'es2022' },
  worker: { format: 'es' },
  server: {
    port: 5180, host: true, fs: { allow: ['..'] },
    proxy: { '/api': { target, ws: true }, '/auth': { target } }, // ws: Sora Ningyō's pose relay
  },
});

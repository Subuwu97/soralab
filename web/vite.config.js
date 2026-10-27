import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev: Vite on 5180 proxies to the SoraLab server (4800).
// Set PUBLIC_URL=http://localhost:5180 in server/.env while developing so sign-in returns here.
const target = process.env.SORALAB_API || 'http://localhost:4800';

const root = path.dirname(fileURLToPath(import.meta.url));

// Sora Ningyō's embeddable avatar (src/embed/ningyo.js, imported by Hikari from another origin) is a second build into
// <outDir>/embed/: a stable ningyo.js and its own chunks, worker, wasm. Its base is relative, so everything it loads
// resolves against the module's own URL (SoraLab), not the page that imports it. In dev, /embed/ningyo.js is the source.
function ningyoEmbed() {
  let outDir = 'dist';
  return {
    name: 'soralab-ningyo-embed',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    configureServer(server) {
      server.middlewares.use((req, res, next) => { if (req.url?.startsWith('/embed/ningyo.js')) req.url = req.url.replace('/embed/ningyo.js', '/src/embed/ningyo.js'); next(); });
    },
    async closeBundle() {
      if (this.meta?.watchMode) return;
      await build({
        configFile: false, root, base: './', logLevel: 'warn', publicDir: false,
        worker: { format: 'es' },
        build: {
          outDir: path.join(outDir, 'embed'), emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 4000,
          rollupOptions: {
            input: path.join(root, 'src/embed/ningyo.js'), preserveEntrySignatures: 'strict',
            output: { entryFileNames: 'ningyo.js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' },
          },
        },
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ningyoEmbed()],
  // suite/web (the notification bell, install helpers) lives outside this folder.
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { chunkSizeWarningLimit: 4000, target: 'es2022' },
  worker: { format: 'es' },
  server: {
    port: 5180, host: true, fs: { allow: ['..'] },
    proxy: { '/api': { target, ws: true }, '/auth': { target } }, // ws: Sora Ningyō's pose relay
  },
});

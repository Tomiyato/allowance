import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const webDir = fileURLToPath(new URL(".", import.meta.url));
const sharedDir = fileURLToPath(new URL("../shared", import.meta.url));
// Override when port 3000 is taken: API_TARGET=http://localhost:3001 npm run dev
const backend = process.env.API_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1600 },
  server: {
    port: 5173,
    // shared/types.ts lives outside web/; allow only that folder besides web/.
    fs: { allow: [webDir, sharedDir] },
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/paypal/": { target: backend, changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/paypal/": { target: backend, changeOrigin: true },
    },
  },
});

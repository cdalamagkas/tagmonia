import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [preact()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    // The API runs on :8080 in dev; same-origin in production.
    proxy: { "/api": "http://localhost:8080", "/mb": "http://localhost:8080" },
  },
});

import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: resolve("server/galaxy.ts"),
    outDir: "dist/galaxy-server",
    emptyOutDir: true,
    target: "node22",
    rollupOptions: { external: [/^node:/] },
  },
});

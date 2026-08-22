import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [preact()],
  base: "/",
  build: {
    outDir: fileURLToPath(new URL("../internal/ui/assets", import.meta.url)),
    emptyOutDir: true,
    assetsDir: "static",
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/cytoscape/")) return "cytoscape";
        }
      }
    }
  }
});

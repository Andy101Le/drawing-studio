import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
// COOP/COEP enable SharedArrayBuffer (threaded Wasm, InputRing in Wasm memory).
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
export default defineConfig({
  root: "web/app",
  publicDir: "public",
  server: { headers: isolation, host: true, port: 5173, open: true },
  preview: { headers: isolation, host: true, port: 4173 },
  build: { outDir: "../../dist", emptyOutDir: true, target: "es2022" },
  worker: { format: "es" },
  resolve: { alias: { "@omni": fileURLToPath(new URL("./web/src", import.meta.url)) } },
});

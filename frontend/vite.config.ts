import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

import { webProxy } from "../scripts/web-proxy.mjs";

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss(), {
    name: "graphy-api",
    configureServer(server) { server.middlewares.use(webProxy()); },
    configurePreviewServer(server) { server.middlewares.use(webProxy()); },
  }],
  build: {
    rolldownOptions: {
      output: {
        // vendors in their own long-lived chunks: an app release does not invalidate them, and the browser fetches them in parallel
        codeSplitting: {
          groups: [
            { name: "vendor-react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 40 },
            { name: "vendor-motion", test: /node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/, priority: 30 },
            { name: "vendor-katex", test: /node_modules[\\/]katex[\\/]/, priority: 30 },
            { name: "vendor-max-ui", test: /node_modules[\\/]@maxhub[\\/]/, priority: 30 },
            { name: "vendor-material", test: /node_modules[\\/](@material|lit|lit-html|lit-element|@lit)[\\/]/, priority: 30 },
          ],
        },
      },
    },
  },
  server: { port: 5174, strictPort: true },
});

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  preview: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: ["localhost", ".trycloudflare.com", ".raphcvr.me"],
  },
  build: {
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/phaser")) {
            return "phaser-engine";
          }
          if (id.includes("node_modules/framer-motion")) {
            return "framer-motion";
          }
          if (id.includes("node_modules/@colyseus")) {
            return "colyseus-client";
          }
          if (id.includes("node_modules/react")) {
            return "react-vendor";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: ["localhost", ".trycloudflare.com", ".raphcvr.me"],
  },
});

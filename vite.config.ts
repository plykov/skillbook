import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Served from https://<user>.github.io/skillbook/ — override with BASE_PATH for other hosts.
const base = process.env.BASE_PATH ?? "/skillbook/";

export default defineConfig({
  base,
  build: { target: "es2022" },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon.svg"],
      manifest: {
        name: "Skillbook",
        short_name: "Skillbook",
        description: "Turn a PDF book into a Claude skill.",
        theme_color: "#1f2a24",
        background_color: "#f6f3ec",
        display: "standalone",
        orientation: "portrait",
        start_url: ".",
        scope: ".",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // The pdf.js worker is ~1 MB; precache it so books can be imported offline.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        globPatterns: ["**/*.{js,mjs,css,html,svg,png,webmanifest}"],
        navigateFallback: "index.html",
      },
    }),
  ],
});

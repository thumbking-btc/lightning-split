import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["lightning-split.svg"],
      manifest: {
        name: "Lightning Split",
        short_name: "LN Split",
        description: "원화 더치페이를 Lightning invoice로 정산합니다.",
        theme_color: "#171612",
        background_color: "#f5f1e8",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/lightning-split.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
    }),
  ],
});

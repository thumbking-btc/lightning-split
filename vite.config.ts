import { execFileSync } from "node:child_process";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import packageJson from "./package.json" with { type: "json" };

function resolveGitCommit(): string {
  const environmentCommit =
    process.env.GITHUB_SHA ??
    process.env.CLOUDFLARE_COMMIT_SHA ??
    process.env.CF_PAGES_COMMIT_SHA;
  if (environmentCommit) return environmentCommit.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(`v${packageJson.version}`),
    __GIT_COMMIT__: JSON.stringify(resolveGitCommit()),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
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

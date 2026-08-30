import { execFileSync } from "node:child_process";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
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

const appVersion = `v${packageJson.version}`;
const gitCommit = resolveGitCommit();

function buildIdentityPlugin(): Plugin {
  return {
    name: "lightning-split-build-identity",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build.json",
        source: `${JSON.stringify({ version: appVersion, commit: gitCommit })}\n`,
      });
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __GIT_COMMIT__: JSON.stringify(gitCommit),
  },
  plugins: [
    react(),
    buildIdentityPlugin(),
    VitePWA({
      registerType: "prompt",
      filename: "app-sw.js",
      includeAssets: [
        "lightning-split.svg",
        "icon-192.png",
        "icon-512.png",
        "icon-maskable-512.png",
        "apple-touch-icon.png",
      ],
      workbox: {
        globIgnores: ["**/build.json"],
      },
      manifest: {
        name: "Lightning Split",
        short_name: "LN Split",
        description: "공동 비용을 인원수대로 나누고 각자의 결제 QR을 만듭니다.",
        lang: "ko",
        theme_color: "#171612",
        background_color: "#f5f1e8",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
});

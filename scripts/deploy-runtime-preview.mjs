import { spawnSync } from "node:child_process";

const isWorkersBuild = process.env.WORKERS_CI === "1";
const branch = process.env.WORKERS_CI_BRANCH?.trim();

if (!isWorkersBuild || branch !== "preview/settlement-history") {
  process.exit(0);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const deploy = spawnSync(
  npx,
  ["wrangler", "deploy", "--config", "wrangler.runtime-preview.jsonc"],
  {
    encoding: "utf8",
    env: process.env,
  },
);

if (deploy.stdout) process.stdout.write(deploy.stdout);
if (deploy.stderr) process.stderr.write(deploy.stderr);
if (deploy.error) throw deploy.error;
if (deploy.status !== 0) {
  throw new Error(
    `Runtime Preview deployment failed with exit code ${deploy.status ?? "unknown"}.`,
  );
}

const previewUrl =
  "https://lightning-split-preview-runtime.thumbking-btc.workers.dev/";
let lastError;
for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    const response = await fetch(previewUrl, {
      headers: { "User-Agent": "lightning-split-runtime-preview-smoke-test" },
      redirect: "follow",
    });
    const body = await response.text();
    if (response.ok && /LIGHTNING SPLIT|Lightning Split/u.test(body)) {
      const manifest = await fetch(`${previewUrl}manifest.webmanifest`, {
        headers: { "User-Agent": "lightning-split-runtime-preview-smoke-test" },
      });
      if (manifest.ok) {
        console.log(`Verified runtime Preview PWA: ${previewUrl}`);
        process.exit(0);
      }
      lastError = new Error(
        `Runtime Preview app shell loaded but manifest returned HTTP ${manifest.status}.`,
      );
    } else {
      lastError = new Error(
        `Runtime Preview returned HTTP ${response.status} without the Lightning Split app shell.`,
      );
    }
  } catch (cause) {
    lastError = cause;
  }

  if (attempt < 12) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

throw new Error(`Runtime Preview was deployed but is not usable: ${previewUrl}`, {
  cause: lastError,
});

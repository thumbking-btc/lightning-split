import { spawnSync } from "node:child_process";

if (process.env.WORKERS_CI !== "1") {
  process.exit(0);
}

const branch = process.env.WORKERS_CI_BRANCH?.trim();
if (branch !== "preview/settlement-history") {
  process.exit(0);
}

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "wrangler",
    "versions",
    "upload",
    "--preview-alias",
    "preview-settlement-history",
  ],
  {
    stdio: "inherit",
    env: process.env,
  },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `Cloudflare preview alias upload failed with exit code ${result.status ?? "unknown"}.`,
  );
}

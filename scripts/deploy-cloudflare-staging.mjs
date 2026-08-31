import { spawnSync } from "node:child_process";

const isWorkersBuild = process.env.WORKERS_CI === "1";

if (!isWorkersBuild) {
  process.exit(0);
}

const branch = process.env.WORKERS_CI_BRANCH?.trim();
if (!branch) {
  throw new Error(
    "WORKERS_CI_BRANCH is missing in Cloudflare Workers Builds; refusing branch-dependent deployment.",
  );
}

if (branch === "main") {
  console.log("Production branch detected; staging postbuild deployment skipped.");
  process.exit(0);
}

console.log(`Non-production branch ${branch} detected; deploying isolated staging Worker.`);

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["wrangler", "deploy", "--env", "staging"],
  {
    stdio: "inherit",
    env: process.env,
  },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Staging deployment failed with exit code ${result.status ?? "unknown"}.`);
}

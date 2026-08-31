import { randomBytes } from "node:crypto";
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

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function runWrangler(args, options = {}) {
  const result = spawnSync(npx, ["wrangler", ...args], {
    env: process.env,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Wrangler ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`,
    );
  }
  return result;
}

console.log(
  `Non-production branch ${branch} detected; deploying isolated staging Worker.`,
);
runWrangler(["deploy", "--env", "staging"], { stdio: "inherit" });

const secretList = runWrangler(["secret", "list", "--env", "staging"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});

let secrets;
try {
  secrets = JSON.parse(secretList.stdout.trim() || "[]");
} catch (cause) {
  throw new Error("Could not parse the staging Worker secret list.", {
    cause,
  });
}

if (
  !Array.isArray(secrets) ||
  !secrets.some(
    (secret) =>
      secret &&
      typeof secret === "object" &&
      secret.name === "VERIFICATION_TOKEN_SECRET",
  )
) {
  console.log("Creating the staging-only verification secret.");
  const secret = randomBytes(32).toString("hex");
  runWrangler(
    ["secret", "put", "VERIFICATION_TOKEN_SECRET", "--env", "staging"],
    {
      encoding: "utf8",
      input: `${secret}\n`,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
}

console.log("Staging Worker deployment and secret configuration completed.");

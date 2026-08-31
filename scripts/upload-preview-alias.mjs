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
    encoding: "utf8",
    env: process.env,
  },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `Cloudflare preview alias upload failed with exit code ${result.status ?? "unknown"}.`,
  );
}

const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const urls = [...output.matchAll(/https:\/\/[^\s]+\.workers\.dev\/?/gu)].map(
  (match) => match[0].replace(/[),.;]+$/u, ""),
);
const previewUrl =
  urls.find((url) => url.includes("preview-settlement-history-lightning-split")) ??
  urls.find((url) => url.includes("-lightning-split."));

if (!previewUrl) {
  throw new Error(
    "Wrangler completed but did not return a Preview URL. Refusing to report this build as preview-ready.",
  );
}

let lastError;
for (let attempt = 1; attempt <= 6; attempt += 1) {
  try {
    const response = await fetch(previewUrl, {
      headers: { "User-Agent": "lightning-split-preview-smoke-test" },
      redirect: "follow",
    });
    const body = await response.text();
    if (response.ok && /LIGHTNING SPLIT|Lightning Split/u.test(body)) {
      console.log(`Verified Preview URL: ${previewUrl}`);
      process.exit(0);
    }
    lastError = new Error(
      `Preview smoke test returned HTTP ${response.status} without the Lightning Split app shell.`,
    );
  } catch (cause) {
    lastError = cause;
  }

  if (attempt < 6) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

throw new Error(`Preview URL was created but did not become usable: ${previewUrl}`, {
  cause: lastError,
});

import { spawnSync } from "node:child_process";

const isWorkersBuild = process.env.WORKERS_CI === "1";
const branch = process.env.WORKERS_CI_BRANCH?.trim();

if (!isWorkersBuild || branch !== "preview/settlement-history") {
  process.exit(0);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const upload = spawnSync(
  npx,
  [
    "wrangler",
    "versions",
    "upload",
    "--preview-alias",
    "settlement-history-preview",
  ],
  {
    encoding: "utf8",
    env: process.env,
  },
);

if (upload.stdout) process.stdout.write(upload.stdout);
if (upload.stderr) process.stderr.write(upload.stderr);
if (upload.error) throw upload.error;
if (upload.status !== 0) {
  throw new Error(
    `Cloudflare Preview upload failed with exit code ${upload.status ?? "unknown"}.`,
  );
}

const output = `${upload.stdout ?? ""}\n${upload.stderr ?? ""}`;
const urls = [...output.matchAll(/https:\/\/[^\s]+\.workers\.dev\/?/gu)].map(
  (match) => match[0].replace(/[),.;]+$/u, ""),
);
const previewUrl =
  urls.find((url) => url.includes("settlement-history-preview-lightning-split")) ??
  urls.find((url) => url.includes("-lightning-split."));

if (!previewUrl) {
  throw new Error(
    "Wrangler uploaded the Preview version but did not return a Preview URL.",
  );
}

let lastError;
for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    const response = await fetch(previewUrl, {
      headers: { "User-Agent": "lightning-split-preview-smoke-test" },
      redirect: "follow",
    });
    const body = await response.text();
    if (response.ok && /LIGHTNING SPLIT|Lightning Split/u.test(body)) {
      const manifest = await fetch(new URL("/manifest.webmanifest", previewUrl), {
        headers: { "User-Agent": "lightning-split-preview-smoke-test" },
        redirect: "follow",
      });
      if (manifest.ok) {
        console.log(`Verified PWA Preview URL: ${previewUrl}`);
        process.exit(0);
      }
      lastError = new Error(
        `Preview app shell loaded but manifest returned HTTP ${manifest.status}.`,
      );
    } else {
      lastError = new Error(
        `Preview returned HTTP ${response.status} without the Lightning Split app shell.`,
      );
    }
  } catch (cause) {
    lastError = cause;
  }

  if (attempt < 12) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

throw new Error(`Preview URL was created but is not usable: ${previewUrl}`, {
  cause: lastError,
});

import { randomBytes } from "node:crypto";
import { access, writeFile } from "node:fs/promises";

const path = new URL("../.dev.vars", import.meta.url);

try {
  await access(path);
  console.log(".dev.vars already exists; no changes were made.");
} catch {
  await writeFile(
    path,
    `VERIFICATION_TOKEN_SECRET=${randomBytes(32).toString("hex")}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log("Created .dev.vars with a local verification token secret.");
}

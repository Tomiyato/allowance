// npm run build: install and build the frontend in web/ (skipped when web/ does not exist yet).
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(new URL("../web/package.json", import.meta.url))) {
  console.log("[build] web/package.json not found; skipping frontend build.");
  process.exit(0);
}
const run = (cmd) => execSync(cmd, { stdio: "inherit" });
run("npm --prefix web install --include=dev");
run("npm --prefix web run build");

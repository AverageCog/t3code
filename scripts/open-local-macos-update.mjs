import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

if (process.platform !== "darwin") {
  throw new Error("update:desktop:mac can only run on macOS.");
}

const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
if (!arch) {
  throw new Error(`Unsupported Mac architecture: ${process.arch}`);
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(repoRoot, "release", "local-macos-update");
const desktopPackage = JSON.parse(
  readFileSync(path.join(repoRoot, "apps", "desktop", "package.json"), "utf8"),
);
const dmgPath = path.join(outputDir, `T3-Code-${desktopPackage.version}-${arch}.dmg`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    ...options,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

if (capture("git", ["status", "--porcelain"]) !== "") {
  throw new Error(
    "The working tree has uncommitted changes. Commit or stash them before running this updater.",
  );
}

if (capture("git", ["branch", "--show-current"]) !== "main") {
  throw new Error("Check out the main branch before running this updater.");
}

console.log("Fetching your fork and the official T3 Code repository...");
run("git", ["fetch", "--prune", "origin"]);
run("git", ["fetch", "--prune", "upstream"]);

// This refuses divergent history. It never resets or force-updates local main.
run("git", ["merge", "--ff-only", "origin/main"]);

const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backupBranch = `backup/pre-upstream-sync-${timestamp}`;
run("git", ["branch", backupBranch, "HEAD"]);
console.log(`Created recovery branch ${backupBranch}`);

console.log("Merging official upstream/main while preserving your commits...");
run("git", ["merge", "--no-edit", "upstream/main"]);

// A normal push is intentional: Git rejects this if it is not fast-forwardable.
console.log("Pushing the updated history to your fork...");
run("git", ["push", "origin", "main"]);

console.log(`Building the ${arch} macOS installer...`);
run(process.execPath, [
  "scripts/build-desktop-artifact.ts",
  "--platform",
  "mac",
  "--target",
  "dmg",
  "--arch",
  arch,
  "--output-dir",
  outputDir,
]);

run("open", [dmgPath]);

console.log(`Opened ${dmgPath}`);

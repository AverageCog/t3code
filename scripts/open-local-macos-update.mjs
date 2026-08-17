import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

if (Effect.runSync(HostProcessPlatform) !== "darwin") {
  throw new Error("update:desktop:mac can only run on macOS.");
}

const hostArchitecture = Effect.runSync(HostProcessArchitecture);
const arch =
  hostArchitecture === "arm64" ? "arm64" : hostArchitecture === "x64" ? "x64" : undefined;
if (!arch) {
  throw new Error(`Unsupported Mac architecture: ${hostArchitecture}`);
}

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    ...options,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

function capture(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, {
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

function resolveGitHubRepository(remoteUrl) {
  const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`The origin remote is not a supported GitHub repository URL: ${remoteUrl}`);
  }
  return `${match[1]}/${match[2]}`;
}

function createReleaseVersion(now) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const dayAndTime = [
    now.getUTCDate(),
    now.getUTCHours().toString().padStart(2, "0"),
    now.getUTCMinutes().toString().padStart(2, "0"),
    now.getUTCSeconds().toString().padStart(2, "0"),
  ].join("");
  return `${year}.${month}.${dayAndTime}`;
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

const updateRepository = resolveGitHubRepository(capture("git", ["remote", "get-url", "origin"]));
const releaseVersion = createReleaseVersion(new Date());
const releaseTag = `fork-v${releaseVersion}`;
const outputDir = NodePath.join(repoRoot, "release", "local-macos-update", releaseVersion);
const dmgPath = NodePath.join(outputDir, `T3-Code-${releaseVersion}-${arch}.dmg`);

console.log(`Building the ${arch} macOS installer...`);
run(
  process.execPath,
  [
    "scripts/build-desktop-artifact.ts",
    "--platform",
    "mac",
    "--target",
    "dmg",
    "--arch",
    arch,
    "--build-version",
    releaseVersion,
    "--output-dir",
    outputDir,
  ],
  {
    env: {
      ...process.env,
      T3CODE_DESKTOP_UPDATE_REPOSITORY: updateRepository,
    },
  },
);

const releaseAssets = NodeFS.readdirSync(outputDir)
  .filter(
    (name) =>
      name === "latest-mac.yml" ||
      name.endsWith(".dmg") ||
      name.endsWith(".zip") ||
      name.endsWith(".blockmap"),
  )
  .map((name) => NodePath.join(outputDir, name));

if (!releaseAssets.some((assetPath) => assetPath.endsWith("latest-mac.yml"))) {
  throw new Error("The build did not produce latest-mac.yml for the custom update feed.");
}

console.log(`Publishing ${releaseTag} to ${updateRepository}...`);
run("gh", [
  "release",
  "create",
  releaseTag,
  ...releaseAssets,
  "--repo",
  updateRepository,
  "--target",
  "main",
  "--title",
  `Custom T3 Code ${releaseVersion}`,
  "--notes",
  "Custom fork build containing the latest merged upstream changes.",
  "--latest",
]);

run("open", [dmgPath]);

console.log(`Opened ${dmgPath}`);

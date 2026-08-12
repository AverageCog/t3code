import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";

export type MacCodeSignatureKind = "developer-id" | "adhoc" | "unknown";

export function resolveMacAppBundlePath(appPath: string): string | undefined {
  const parts = appPath.split(path.sep);
  const index = parts.findIndex((part) => part.endsWith(".app"));
  if (index < 0) {
    return undefined;
  }
  return parts.slice(0, index + 1).join(path.sep);
}

export function classifyMacCodesignOutput(output: string): MacCodeSignatureKind {
  if (/TeamIdentifier=[A-Z0-9]{10}/.test(output)) {
    return "developer-id";
  }
  if (/Signature=adhoc/i.test(output) || /TeamIdentifier=not set/.test(output)) {
    return "adhoc";
  }
  return "unknown";
}

export function inspectMacAppSignature(bundlePath: string): MacCodeSignatureKind {
  const result = spawnSync("codesign", ["-dv", "--verbose=2", bundlePath], {
    encoding: "utf8",
  });
  return classifyMacCodesignOutput(`${result.stdout}\n${result.stderr}`);
}

export function resolveDownloadedMacUpdateZip(cacheDir: string): string | undefined {
  const updateZip = path.join(cacheDir, "update.zip");
  if (existsSync(updateZip)) {
    return updateZip;
  }

  const pendingDir = path.join(cacheDir, "pending");
  if (!existsSync(pendingDir)) {
    return undefined;
  }

  const pendingZip = readdirSync(pendingDir)
    .filter((name) => name.endsWith(".zip"))
    .map((name) => path.join(pendingDir, name))
    .at(0);
  return pendingZip;
}

export function resolveMacUpdaterCacheDir(
  homeDirectory: string,
  updaterCacheDirName: string,
): string {
  return path.join(homeDirectory, "Library", "Caches", updaterCacheDirName);
}

export function buildUnsignedMacInstallScript(): string {
  return `#!/bin/bash
set -euo pipefail
zip_path="$1"
dest_app="$2"
exe="$dest_app/Contents/MacOS"
tmpdir="$(mktemp -d /tmp/t3-unsigned-update.XXXXXX)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT
ditto -x -k "$zip_path" "$tmpdir"
app="$(find "$tmpdir" -maxdepth 1 -name '*.app' -print -quit)"
if [[ -z "$app" ]]; then
  echo "unsigned mac update zip did not contain an .app bundle" >&2
  exit 1
fi
# Wait for this specific install to release the executable, not any similarly named process.
if [[ -d "$exe" ]]; then
  while /usr/sbin/lsof "$exe"/* >/dev/null 2>&1; do
    sleep 0.2
  done
fi
ditto --rsrc "$app" "$dest_app"
open "$dest_app"
`;
}

export function spawnUnsignedMacInstaller(options: {
  readonly zipPath: string;
  readonly destAppPath: string;
}): void {
  const child = spawn(
    "/bin/bash",
    [
      "-c",
      buildUnsignedMacInstallScript(),
      "t3-unsigned-update",
      options.zipPath,
      options.destAppPath,
    ],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
}

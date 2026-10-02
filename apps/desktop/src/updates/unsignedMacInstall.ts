// @effect-diagnostics nodeBuiltinImport:off - Electron updater callbacks and detached installer handoff are synchronous OS boundaries.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type MacCodeSignatureKind = "developer-id" | "adhoc" | "unknown";

export function resolveMacAppBundlePath(appPath: string): string | undefined {
  const parts = appPath.split(NodePath.posix.sep);
  const index = parts.findIndex((part) => part.endsWith(".app"));
  if (index < 0) {
    return undefined;
  }
  return parts.slice(0, index + 1).join(NodePath.posix.sep);
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
  const result = NodeChildProcess.spawnSync("codesign", ["-dv", "--verbose=2", bundlePath], {
    encoding: "utf8",
  });
  return classifyMacCodesignOutput(`${result.stdout}\n${result.stderr}`);
}

export function resolveDownloadedMacUpdateZip(cacheDir: string): string | undefined {
  const updateZip = NodePath.join(cacheDir, "update.zip");
  if (NodeFS.existsSync(updateZip)) {
    return updateZip;
  }

  const pendingDir = NodePath.join(cacheDir, "pending");
  if (!NodeFS.existsSync(pendingDir)) {
    return undefined;
  }

  const pendingZip = NodeFS.readdirSync(pendingDir)
    .filter((name) => name.endsWith(".zip"))
    .map((name) => NodePath.join(pendingDir, name))
    .at(0);
  return pendingZip;
}

export function resolveMacUpdaterCacheDir(
  homeDirectory: string,
  updaterCacheDirName: string,
): string {
  return NodePath.posix.join(homeDirectory, "Library", "Caches", updaterCacheDirName);
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
  const child = NodeChildProcess.spawn(
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

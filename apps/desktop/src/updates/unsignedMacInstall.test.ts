// @effect-diagnostics nodeBuiltinImport:off - tests exercise the synchronous macOS updater filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  buildUnsignedMacInstallScript,
  classifyMacCodesignOutput,
  resolveDownloadedMacUpdateZip,
  resolveMacAppBundlePath,
  resolveMacUpdaterCacheDir,
} from "./unsignedMacInstall.ts";

describe("unsignedMacInstall", () => {
  it("walks up from app.asar to the .app bundle", () => {
    expect(
      resolveMacAppBundlePath("/Applications/T3 Code (Alpha).app/Contents/Resources/app.asar"),
    ).toBe("/Applications/T3 Code (Alpha).app");
  });

  it("returns undefined when there is no .app segment", () => {
    expect(resolveMacAppBundlePath("/repo/apps/desktop")).toBeUndefined();
  });

  it("classifies adhoc and Developer ID codesign output", () => {
    expect(classifyMacCodesignOutput("Signature=adhoc\nTeamIdentifier=not set\n")).toBe("adhoc");
    expect(
      classifyMacCodesignOutput(
        "Authority=Developer ID Application: Example\nTeamIdentifier=ABCD123456\n",
      ),
    ).toBe("developer-id");
    expect(classifyMacCodesignOutput("")).toBe("unknown");
  });

  it("prefers update.zip over a pending zip", () => {
    const cacheDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-updater-cache-"));
    const pendingDir = NodePath.join(cacheDir, "pending");
    NodeFS.mkdirSync(pendingDir);
    NodeFS.writeFileSync(NodePath.join(pendingDir, "T3-Code-1.zip"), "pending");
    NodeFS.writeFileSync(NodePath.join(cacheDir, "update.zip"), "complete");

    expect(resolveDownloadedMacUpdateZip(cacheDir)).toBe(NodePath.join(cacheDir, "update.zip"));
  });

  it("falls back to the pending zip when update.zip is missing", () => {
    const cacheDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-updater-cache-"));
    const pendingDir = NodePath.join(cacheDir, "pending");
    NodeFS.mkdirSync(pendingDir);
    NodeFS.writeFileSync(NodePath.join(pendingDir, "T3-Code-1.zip"), "pending");

    expect(resolveDownloadedMacUpdateZip(cacheDir)).toBe(
      NodePath.join(pendingDir, "T3-Code-1.zip"),
    );
  });

  it("builds the updater cache path under Library/Caches", () => {
    expect(resolveMacUpdaterCacheDir("/Users/jayum", "t3code-updater")).toBe(
      "/Users/jayum/Library/Caches/t3code-updater",
    );
  });

  it("installs from $1/$2 so bash -c can pass zip and destination", () => {
    const script = buildUnsignedMacInstallScript();
    expect(script).toContain('zip_path="$1"');
    expect(script).toContain('dest_app="$2"');
    expect(script).toContain("ditto -x -k");
    expect(script).toContain("ditto --rsrc");
    expect(script).toContain("/usr/sbin/lsof");
  });
});

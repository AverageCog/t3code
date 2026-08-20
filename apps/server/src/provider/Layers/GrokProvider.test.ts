import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@t3tools/contracts";

import {
  buildGrokCapabilitiesFromModelMeta,
  buildGrokDiscoveredModelsFromSessionModelState,
  buildInitialGrokProviderSnapshot,
  buildGrokSubscriptionUsageFromBilling,
  checkGrokProviderStatus,
  requestGrokSubscriptionUsage,
} from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

describe("buildGrokCapabilitiesFromModelMeta", () => {
  it("returns empty capabilities when reasoning is unsupported", () => {
    expect(buildGrokCapabilitiesFromModelMeta(undefined).optionDescriptors).toEqual([]);
    expect(
      buildGrokCapabilitiesFromModelMeta({ supportsReasoningEffort: false }).optionDescriptors,
    ).toEqual([]);
  });

  it("maps Grok 4.5 reasoning efforts into a select option descriptor", () => {
    const capabilities = buildGrokCapabilitiesFromModelMeta({
      supportsReasoningEffort: true,
      reasoningEffort: "high",
      reasoningEfforts: [
        {
          id: "high",
          value: "high",
          label: "High Effort",
          default: true,
        },
        {
          id: "medium",
          value: "medium",
          label: "Medium Effort",
          default: false,
        },
        {
          id: "low",
          value: "low",
          label: "Low Effort",
          default: false,
        },
      ],
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "high",
        options: [
          { id: "high", label: "High Effort", isDefault: true },
          { id: "medium", label: "Medium Effort" },
          { id: "low", label: "Low Effort" },
        ],
      },
    ]);
  });

  it("prefers entry.value over entry.id for the wire token", () => {
    const capabilities = buildGrokCapabilitiesFromModelMeta({
      supportsReasoningEffort: true,
      reasoningEffort: "high",
      reasoningEfforts: [
        {
          id: "effort-high",
          value: "high",
          label: "High Effort",
          default: true,
        },
        {
          id: "effort-low",
          value: "low",
          label: "Low Effort",
        },
      ],
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "high",
        options: [
          { id: "high", label: "High Effort", isDefault: true },
          { id: "low", label: "Low Effort" },
        ],
      },
    ]);
  });

  it("defaults to the first effort when no default or current is advertised", () => {
    const capabilities = buildGrokCapabilitiesFromModelMeta({
      supportsReasoningEffort: true,
      reasoningEfforts: [
        { id: "medium", value: "medium", label: "Medium Effort" },
        { id: "low", value: "low", label: "Low Effort" },
      ],
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "medium",
        options: [
          { id: "medium", label: "Medium Effort", isDefault: true },
          { id: "low", label: "Low Effort" },
        ],
      },
    ]);
  });
});

describe("buildGrokDiscoveredModelsFromSessionModelState", () => {
  it("attaches reasoning capabilities from model meta", () => {
    const models = buildGrokDiscoveredModelsFromSessionModelState({
      currentModelId: "grok-4.5",
      availableModels: [
        {
          modelId: "grok-4.5",
          name: "Grok 4.5",
          description: "SpaceXAI's new frontier model",
          _meta: {
            supportsReasoningEffort: true,
            reasoningEffort: "high",
            reasoningEfforts: [
              { id: "high", value: "high", label: "High Effort", default: true },
              { id: "medium", value: "medium", label: "Medium Effort", default: false },
              { id: "low", value: "low", label: "Low Effort", default: false },
            ],
          },
        },
        {
          modelId: "grok-build",
          name: "Grok Build",
        },
      ],
    });

    expect(models.map((model) => model.slug)).toEqual(["grok-4.5", "grok-build"]);
    expect(models[0]?.capabilities?.optionDescriptors?.[0]?.id).toBe("reasoningEffort");
    expect(models[1]?.capabilities?.optionDescriptors ?? []).toEqual([]);
  });
});

describe("buildGrokSubscriptionUsageFromBilling", () => {
  it("maps Grok's current shared weekly subscription pool", () => {
    expect(
      buildGrokSubscriptionUsageFromBilling({
        subscriptionTier: "SuperGrok Heavy",
        config: {
          creditUsagePercent: 42.5,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-06-01T00:00:00Z",
            end: "2026-06-08T00:00:00Z",
          },
          isUnifiedBillingUser: true,
        },
      }),
    ).toEqual({
      provider: "grok",
      plan: "SuperGrok Heavy",
      windows: [
        {
          kind: "weekly",
          usedPercent: 42.5,
          windowDurationMinutes: 10_080,
          resetsAt: "2026-06-08T00:00:00.000Z",
        },
      ],
    });
  });

  it("treats an omitted current-period percentage as zero usage", () => {
    expect(
      buildGrokSubscriptionUsageFromBilling({
        subscription_tier: "SuperGrok",
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-08-17T00:00:00Z",
            end: "2026-08-24T00:00:00Z",
          },
        },
      }),
    ).toEqual({
      provider: "grok",
      plan: "SuperGrok",
      windows: [
        {
          kind: "weekly",
          usedPercent: 0,
          windowDurationMinutes: 10_080,
          resetsAt: "2026-08-24T00:00:00.000Z",
        },
      ],
    });
  });

  it.effect("uses Grok's wire-prefixed ACP method and stable response shape", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
      const usage = yield* requestGrokSubscriptionUsage((method, payload) => {
        requests.push({ method, payload });
        return Effect.succeed({
          config: {
            creditUsagePercent: 31,
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              start: "2026-08-10T00:00:00Z",
              end: "2026-08-17T00:00:00Z",
            },
          },
          subscription_tier: "SuperGrok",
        });
      });

      expect(requests).toEqual([{ method: "_x.ai/billing", payload: {} }]);
      expect(usage?.plan).toBe("SuperGrok");
      expect(usage?.windows[0]?.kind).toBe("weekly");
    }),
  );

  it("unwraps compatibility response envelopes", () => {
    expect(
      buildGrokSubscriptionUsageFromBilling({
        result: {
          config: {
            creditUsagePercent: 12,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
          },
        },
      })?.windows[0]?.usedPercent,
    ).toBe(12);
  });

  it("supports Grok's legacy monthly billing response", () => {
    expect(
      buildGrokSubscriptionUsageFromBilling({
        config: {
          monthlyLimit: { val: -2_000 },
          used: { val: -500 },
          billingPeriodStart: "2026-04-01T00:00:00Z",
          billingPeriodEnd: "2026-05-01T00:00:00Z",
        },
      }),
    ).toEqual({
      provider: "grok",
      plan: null,
      windows: [
        {
          kind: "monthly",
          usedPercent: 25,
          windowDurationMinutes: 43_200,
          resetsAt: "2026-05-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("keeps a successful billing read without inventing a window", () => {
    expect(buildGrokSubscriptionUsageFromBilling({ config: null })).toEqual({
      provider: "grok",
      plan: null,
      windows: [],
    });
    expect(buildGrokSubscriptionUsageFromBilling(null)).toBeUndefined();
  });
});

describe("buildInitialGrokProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(decodeGrokSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Grok");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("checkGrokProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken grok install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-version-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Grok CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("attaches subscription usage returned by the ACP billing extension", () =>
    Effect.gen(function* () {
      const subscriptionUsage = {
        provider: "grok" as const,
        plan: "SuperGrok Heavy",
        windows: [
          {
            kind: "weekly" as const,
            usedPercent: 42.5,
            windowDurationMinutes: 10_080,
            resetsAt: "2026-06-08T00:00:00.000Z",
          },
        ],
      };
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-billing-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", 'printf "grok-cli 1.0.3\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            process.env,
            () => Effect.succeed({ models: [], subscriptionUsage }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.subscriptionUsage).toEqual(subscriptionUsage);
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-success-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", 'printf "grok-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );
});

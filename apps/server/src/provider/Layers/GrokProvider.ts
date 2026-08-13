import {
  type GrokSettings,
  type ModelCapabilities,
  type ProviderSubscriptionUsage,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  GROK_REASONING_EFFORT_OPTION_ID,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "../acp/GrokAcpSupport.ts";
import { optionalProviderEnrichment } from "../optionalProviderEnrichment.ts";

const GROK_PRESENTATION = {
  displayName: "Grok",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
export const GROK_BILLING_ACP_METHOD = "_x.ai/billing";

const GrokBillingCent = Schema.Struct({
  val: Schema.optionalKey(Schema.Number),
});

const GrokBillingPeriod = Schema.Struct({
  type: Schema.optionalKey(Schema.NullOr(Schema.String)),
  start: Schema.optionalKey(Schema.NullOr(Schema.String)),
  end: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const GrokBillingConfig = Schema.Struct({
  creditUsagePercent: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  currentPeriod: Schema.optionalKey(Schema.NullOr(GrokBillingPeriod)),
  monthlyLimit: Schema.optionalKey(Schema.NullOr(GrokBillingCent)),
  used: Schema.optionalKey(Schema.NullOr(GrokBillingCent)),
  billingPeriodStart: Schema.optionalKey(Schema.NullOr(Schema.String)),
  billingPeriodEnd: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const GrokBillingResponse = Schema.Struct({
  config: Schema.optionalKey(Schema.NullOr(GrokBillingConfig)),
  subscriptionTier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  subscription_tier: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const decodeGrokBillingResponse = Schema.decodeUnknownOption(GrokBillingResponse);
const decodeGrokBillingResponseEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({ result: GrokBillingResponse }),
);

const GROK_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "grok-build",
    name: "Grok Build",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialGrokProviderSnapshot(
  grokSettings: GrokSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = grokModelsFromSettings(grokSettings.customModels);

    if (!grokSettings.enabled) {
      return buildServerProvider({
        presentation: GROK_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Grok is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Grok CLI availability...",
      },
    });
  });
}

function grokModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = GROK_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const GROK_REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function grokReasoningEffortLabel(value: string): string {
  return GROK_REASONING_EFFORT_LABELS[value] ?? value;
}

/**
 * Builds model capabilities from Grok ACP model `_meta`.
 * Reasoning models advertise `supportsReasoningEffort` and a `reasoningEfforts` menu
 * (see `GROK_REASONING_EFFORT_OPTION_ID`). Wire values prefer `entry.value` over `entry.id`.
 */
export function buildGrokCapabilitiesFromModelMeta(
  meta: Readonly<Record<string, unknown>> | null | undefined,
): ModelCapabilities {
  if (!meta || meta.supportsReasoningEffort !== true) {
    return EMPTY_CAPABILITIES;
  }

  const efforts = meta.reasoningEfforts;
  if (!Array.isArray(efforts) || efforts.length === 0) {
    return EMPTY_CAPABILITIES;
  }

  const currentEffort =
    typeof meta.reasoningEffort === "string" && meta.reasoningEffort.trim().length > 0
      ? meta.reasoningEffort.trim()
      : undefined;

  const parsed = efforts.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    // Prefer the protocol/wire value; fall back to id for older menu shapes.
    const value =
      (typeof entry.value === "string" && entry.value.trim()) ||
      (typeof entry.id === "string" && entry.id.trim()) ||
      undefined;
    if (!value) {
      return [];
    }
    const label =
      (typeof entry.label === "string" && entry.label.trim()) || grokReasoningEffortLabel(value);
    return [
      {
        value,
        label,
        markedDefault: entry.default === true,
      },
    ];
  });

  if (parsed.length === 0) {
    return EMPTY_CAPABILITIES;
  }

  // Prefer menu default, then advertised current effort, then first entry so the
  // composer always has an explicit selection for reasoning models.
  const preferredDefault =
    parsed.find((option) => option.markedDefault)?.value ??
    (currentEffort && parsed.some((option) => option.value === currentEffort)
      ? currentEffort
      : parsed[0]?.value);

  const options = parsed.map((option) =>
    preferredDefault !== undefined && option.value === preferredDefault
      ? { value: option.value, label: option.label, isDefault: true as const }
      : { value: option.value, label: option.label },
  );

  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: GROK_REASONING_EFFORT_OPTION_ID,
        label: "Reasoning",
        options,
      }),
    ],
  });
}

export function buildGrokDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveGrokAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      const meta = isRecord(model._meta) ? model._meta : undefined;
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: buildGrokCapabilitiesFromModelMeta(meta),
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

function normalizedIsoDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  return Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

function grokBillingWindowDurationMinutes(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const parsedStart = DateTime.make(start);
  const parsedEnd = DateTime.make(end);
  if (Option.isNone(parsedStart) || Option.isNone(parsedEnd)) return null;
  const duration =
    DateTime.toEpochMillis(parsedEnd.value) - DateTime.toEpochMillis(parsedStart.value);
  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration / 60_000) : null;
}

/** Normalizes the consumer billing shape reported by Grok's `x.ai/billing` ACP extension. */
export function buildGrokSubscriptionUsageFromBilling(
  input: unknown,
): ProviderSubscriptionUsage | undefined {
  const envelope = decodeGrokBillingResponseEnvelope(input);
  const decoded = Option.isSome(envelope)
    ? Option.some(envelope.value.result)
    : decodeGrokBillingResponse(input);
  if (Option.isNone(decoded)) return undefined;

  const response = decoded.value;
  const plan = response.subscriptionTier?.trim() || response.subscription_tier?.trim() || null;
  const config = response.config ?? null;
  if (!config) {
    return { provider: "grok", plan, windows: [] };
  }

  const currentPeriod = config.currentPeriod ?? null;
  const start = normalizedIsoDateTime(currentPeriod?.start ?? config.billingPeriodStart);
  const resetsAt = normalizedIsoDateTime(currentPeriod?.end ?? config.billingPeriodEnd);
  const windowDurationMinutes = grokBillingWindowDurationMinutes(start, resetsAt);
  const periodType = currentPeriod?.type?.trim().toUpperCase();
  const kind = periodType?.includes("WEEKLY")
    ? ("weekly" as const)
    : periodType?.includes("MONTHLY")
      ? ("monthly" as const)
      : config.monthlyLimit !== null && config.monthlyLimit !== undefined
        ? ("monthly" as const)
        : windowDurationMinutes === 10_080
          ? ("weekly" as const)
          : undefined;

  const directPercent = config.creditUsagePercent;
  const legacyLimit = Math.abs(config.monthlyLimit?.val ?? 0);
  const legacyUsed = Math.abs(config.used?.val ?? 0);
  const usedPercent =
    typeof directPercent === "number" && Number.isFinite(directPercent)
      ? directPercent
      : legacyLimit > 0 && Number.isFinite(legacyUsed)
        ? (legacyUsed / legacyLimit) * 100
        : undefined;

  if (!kind || usedPercent === undefined) {
    return { provider: "grok", plan, windows: [] };
  }

  return {
    provider: "grok",
    plan,
    windows: [
      {
        kind,
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        windowDurationMinutes,
        resetsAt,
      },
    ],
  };
}

export function requestGrokSubscriptionUsage<E>(
  request: (method: string, payload: unknown) => Effect.Effect<unknown, E>,
): Effect.Effect<ProviderSubscriptionUsage | undefined, E> {
  return request(GROK_BILLING_ACP_METHOD, {}).pipe(
    Effect.map(buildGrokSubscriptionUsageFromBilling),
  );
}

const probeGrokViaAcp = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeGrokAcpRuntime({
      grokSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    const billing = yield* optionalProviderEnrichment(requestGrokSubscriptionUsage(acp.request));
    const subscriptionUsage = Option.isSome(billing) ? billing.value : undefined;
    return {
      models: buildGrokDiscoveredModelsFromSessionModelState(started.sessionSetupResult.models),
      ...(subscriptionUsage ? { subscriptionUsage } : {}),
    };
  }).pipe(Effect.scoped);

const runGrokVersionCommand = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = grokSettings.binaryPath || "grok";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkGrokProviderStatus = Effect.fn("checkGrokProviderStatus")(function* (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
  acpProbe: typeof probeGrokViaAcp = probeGrokViaAcp,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = grokModelsFromSettings(grokSettings.customModels);

  if (!grokSettings.enabled) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Grok is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runGrokVersionCommand(grokSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Grok CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Grok CLI (`grok`) is not installed or not on PATH."
          : "Failed to execute Grok CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but timed out while running `grok --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Grok CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* acpProbe(grokSettings, environment).pipe(
    Effect.timeoutOption(GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Grok ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Grok ACP model discovery timed out after ${GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Grok CLI is installed but ACP startup timed out after ${GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const acpSnapshot = discoveryExit.value.value;
  const discoveredModels = acpSnapshot.models;
  const models =
    discoveredModels.length > 0
      ? grokModelsFromSettings(grokSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: GROK_PRESENTATION,
    enabled: grokSettings.enabled,
    checkedAt,
    models,
    ...(acpSnapshot.subscriptionUsage ? { subscriptionUsage: acpSnapshot.subscriptionUsage } : {}),
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichGrokSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Grok version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};

import {
  type GrokSettings,
  type ProviderOptionSelection,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { getProviderOptionStringSelectionValue, normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { makeXAiPromptCompletionRuntime } from "./XAiAcpExtension.ts";

const GROK_API_KEY_ENV = "XAI_API_KEY";
const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const T3_CODE_OAUTH_REFERRER = "t3code";
const GROK_AUTH_METHOD_API_KEY = "xai.api_key";
const GROK_AUTH_METHOD_CACHED_TOKEN = "cached_token";
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");
/**
 * Model option id and ACP `session/set_model` `_meta` key for Grok reasoning effort.
 *
 * Grok ACP model `_meta` advertises:
 * - `supportsReasoningEffort: true`
 * - `reasoningEffort`: current effort wire value
 * - `reasoningEfforts`: menu entries with `{ id?, value, label?, default? }`
 *   where `value` is the wire token for `_meta.reasoningEffort` (prefer over `id`).
 */
export const GROK_REASONING_EFFORT_OPTION_ID = "reasoningEffort";

type GrokAcpRuntimeGrokSettings = Pick<GrokSettings, "binaryPath">;

interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeGrokSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: grokSettings?.binaryPath || "grok",
    args: ["agent", "stdio"],
    cwd,
    env: {
      ...environment,
      [GROK_OAUTH2_REFERRER_ENV]: T3_CODE_OAUTH_REFERRER,
    },
  };
}

function resolveGrokAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[GROK_API_KEY_ENV]?.trim()
    ? GROK_AUTH_METHOD_API_KEY
    : GROK_AUTH_METHOD_CACHED_TOKEN;
}

export const makeGrokAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGrokAcpSpawnInput(input.grokSettings, input.cwd, input.environment),
        authMethodId: resolveGrokAuthMethodId(input.environment),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    return yield* makeXAiPromptCompletionRuntime(runtime);
  });

export function resolveGrokAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "grok-build";
  return normalizeModelSlug(base, GROK_DRIVER_KIND) ?? "grok-build";
}

export function currentGrokModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

/**
 * Reads the current reasoning effort advertised on the active model in session setup.
 * Grok exposes this on each model entry's `_meta.reasoningEffort`.
 */
export function currentGrokReasoningEffortFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const models = sessionSetupResult.models;
  if (!models) {
    return undefined;
  }
  const currentModelId = models.currentModelId?.trim();
  const active =
    (currentModelId
      ? models.availableModels.find((model) => model.modelId.trim() === currentModelId)
      : undefined) ?? models.availableModels[0];
  const meta = active?._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const effort = (meta as Record<string, unknown>).reasoningEffort;
  return typeof effort === "string" && effort.trim().length > 0 ? effort.trim() : undefined;
}

export function resolveGrokReasoningEffortSelection(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): string | undefined {
  const raw = getProviderOptionStringSelectionValue(selections, GROK_REASONING_EFFORT_OPTION_ID);
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export interface GrokAcpModelSelectionResult {
  readonly modelId: string | undefined;
  readonly reasoningEffort: string | undefined;
}

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly currentReasoningEffort?: string | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<GrokAcpModelSelectionResult, E> {
  const targetModelId = input.requestedModelId ?? input.currentModelId;
  const requestedReasoningEffort = resolveGrokReasoningEffortSelection(input.selections);
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  const shouldApplyReasoningEffort =
    requestedReasoningEffort !== undefined &&
    requestedReasoningEffort !== input.currentReasoningEffort;

  if (!shouldSwitchModel && !shouldApplyReasoningEffort) {
    return Effect.succeed({
      modelId: input.currentModelId,
      reasoningEffort: input.currentReasoningEffort,
    });
  }

  if (targetModelId === undefined) {
    return Effect.succeed({
      modelId: input.currentModelId,
      reasoningEffort: input.currentReasoningEffort,
    });
  }

  const meta =
    requestedReasoningEffort !== undefined
      ? { [GROK_REASONING_EFFORT_OPTION_ID]: requestedReasoningEffort }
      : undefined;

  // Model switches without an explicit effort selection leave Grok free to reset
  // effort. Clear local tracking so the next selection re-applies instead of
  // treating a stale effort as authoritative.
  const nextReasoningEffort = shouldSwitchModel
    ? requestedReasoningEffort
    : (requestedReasoningEffort ?? input.currentReasoningEffort);

  return input.runtime.setSessionModel(targetModelId, meta ? { meta } : undefined).pipe(
    Effect.mapError(input.mapError),
    Effect.as({
      modelId: targetModelId,
      reasoningEffort: nextReasoningEffort,
    }),
  );
}

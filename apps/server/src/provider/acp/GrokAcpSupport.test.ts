import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  GROK_REASONING_EFFORT_OPTION_ID,
  resolveGrokAcpBaseModelId,
  resolveGrokReasoningEffortSelection,
  currentGrokReasoningEffortFromSessionSetup,
} from "./GrokAcpSupport.ts";

describe("resolveGrokAcpBaseModelId", () => {
  it("normalizes empty and custom Grok model ids", () => {
    expect(resolveGrokAcpBaseModelId(undefined)).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("   ")).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("  grok-test-custom-model  ")).toBe("grok-test-custom-model");
  });
});

describe("resolveGrokReasoningEffortSelection", () => {
  it("reads the reasoningEffort option", () => {
    expect(
      resolveGrokReasoningEffortSelection([{ id: GROK_REASONING_EFFORT_OPTION_ID, value: "low" }]),
    ).toBe("low");
    expect(resolveGrokReasoningEffortSelection([{ id: "other", value: "low" }])).toBeUndefined();
    expect(resolveGrokReasoningEffortSelection(undefined)).toBeUndefined();
  });
});

describe("currentGrokReasoningEffortFromSessionSetup", () => {
  it("reads reasoningEffort from the active model meta", () => {
    expect(
      currentGrokReasoningEffortFromSessionSetup({
        sessionId: "s1",
        models: {
          currentModelId: "grok-4.5",
          availableModels: [
            {
              modelId: "grok-4.5",
              name: "Grok 4.5",
              _meta: {
                supportsReasoningEffort: true,
                reasoningEffort: "high",
              },
            },
          ],
        },
      }),
    ).toBe("high");
  });

  it("returns undefined when meta is missing", () => {
    expect(
      currentGrokReasoningEffortFromSessionSetup({
        sessionId: "s1",
        models: {
          currentModelId: "grok-build",
          availableModels: [{ modelId: "grok-build", name: "Grok Build" }],
        },
      }),
    ).toBeUndefined();
  });
});

describe("buildGrokAcpSpawnInput", () => {
  it("passes the T3 Code referrer through Grok OAuth env", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "/usr/local/bin/grok" }, "/tmp/project", {
      XAI_API_KEY: "secret",
      GROK_OAUTH2_REFERRER: "other-client",
    });

    expect(spawn).toEqual({
      command: "/usr/local/bin/grok",
      args: ["agent", "stdio"],
      cwd: "/tmp/project",
      env: {
        XAI_API_KEY: "secret",
        GROK_OAUTH2_REFERRER: "t3code",
      },
    });
  });
});

describe("applyGrokAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<{
      modelId: string;
      meta?: Readonly<Record<string, unknown>>;
    }> = [];
    const runtime = {
      setSessionModel: (
        modelId: string,
        options?: { readonly meta?: Readonly<Record<string, unknown>> },
      ) =>
        Effect.gen(function* () {
          modelCalls.push(
            options?.meta !== undefined ? { modelId, meta: options.meta } : { modelId },
          );
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-mock-alt",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-mock-alt" }]);
      expect(result).toEqual({ modelId: "grok-mock-alt", reasoningEffort: undefined });
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-build",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toEqual({ modelId: "grok-build", reasoningEffort: undefined });
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toEqual({ modelId: "grok-build", reasoningEffort: undefined });
    }),
  );

  it.effect("applies reasoningEffort via set_model meta when effort changes", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.5",
        requestedModelId: "grok-4.5",
        currentReasoningEffort: "high",
        selections: [{ id: GROK_REASONING_EFFORT_OPTION_ID, value: "low" }],
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([
        {
          modelId: "grok-4.5",
          meta: { reasoningEffort: "low" },
        },
      ]);
      expect(result).toEqual({ modelId: "grok-4.5", reasoningEffort: "low" });
    }),
  );

  it.effect("applies effort-only when requestedModelId is undefined", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.5",
        requestedModelId: undefined,
        currentReasoningEffort: "high",
        selections: [{ id: GROK_REASONING_EFFORT_OPTION_ID, value: "low" }],
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([
        {
          modelId: "grok-4.5",
          meta: { reasoningEffort: "low" },
        },
      ]);
      expect(result).toEqual({ modelId: "grok-4.5", reasoningEffort: "low" });
    }),
  );

  it.effect("applies model and reasoningEffort together", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-4.5",
        currentReasoningEffort: undefined,
        selections: [{ id: GROK_REASONING_EFFORT_OPTION_ID, value: "medium" }],
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([
        {
          modelId: "grok-4.5",
          meta: { reasoningEffort: "medium" },
        },
      ]);
      expect(result).toEqual({ modelId: "grok-4.5", reasoningEffort: "medium" });
    }),
  );

  it.effect("clears tracked effort on model switch without selections", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-4.5",
        currentReasoningEffort: "low",
        selections: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.5" }]);
      // Do not preserve stale effort as authoritative after a model switch.
      expect(result).toEqual({ modelId: "grok-4.5", reasoningEffort: undefined });
    }),
  );

  it.effect("skips set_model when reasoning effort is already active", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.5",
        requestedModelId: "grok-4.5",
        currentReasoningEffort: "low",
        selections: [{ id: GROK_REASONING_EFFORT_OPTION_ID, value: "low" }],
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toEqual({ modelId: "grok-4.5", reasoningEffort: "low" });
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyGrokAcpModelSelection({
          runtime,
          currentModelId: "grok-build",
          requestedModelId: "grok-mock-alt",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

import { describe, expect, it } from "vite-plus/test";

import {
  estimateGrokContextTokensUsed,
  extractGrokContextWindow,
  parseGrokTurnUsageTotals,
  resolveGrokHomePath,
  resolveGrokModelContextWindow,
  resolveGrokSignalsFilePath,
  snapshotFromGrokTurnUsage,
  snapshotFromXAiSessionUpdate,
  unwrapXAiSessionUpdate,
} from "./GrokTokenUsage.ts";

describe("resolveGrokSignalsFilePath", () => {
  it("matches Grok's encoded session directory layout", () => {
    expect(
      resolveGrokSignalsFilePath({
        grokHome: "/Users/jayum/.grok",
        cwd: "/Users/jayum/Desktop/HermesNative",
        sessionId: "019ff7f0-a662-7282-a07c-b5e146ba0ec5",
      }),
    ).toBe(
      "/Users/jayum/.grok/sessions/%2FUsers%2Fjayum%2FDesktop%2FHermesNative/019ff7f0-a662-7282-a07c-b5e146ba0ec5/signals.json",
    );
  });

  it("prefers GROK_HOME over HOME", () => {
    expect(resolveGrokHomePath({ GROK_HOME: "/tmp/grok-home", HOME: "/Users/jayum" })).toBe(
      "/tmp/grok-home",
    );
  });
});

describe("resolveGrokModelContextWindow", () => {
  it("uses the published 500k window for current Grok coding models", () => {
    expect(resolveGrokModelContextWindow("grok-4.6-build")).toBe(500_000);
    expect(resolveGrokModelContextWindow("grok-4.5")).toBe(500_000);
    expect(resolveGrokModelContextWindow("grok-build")).toBe(500_000);
    expect(resolveGrokModelContextWindow(undefined)).toBe(500_000);
  });

  it("uses the 2M window for Grok 4 Fast", () => {
    expect(resolveGrokModelContextWindow("grok-4-fast")).toBe(2_000_000);
  });

  it("does not invent a window for unrelated slugs", () => {
    expect(resolveGrokModelContextWindow("custom-hosted-model")).toBeUndefined();
  });
});

describe("estimateGrokContextTokensUsed", () => {
  it("uses input tokens when the turn made a single model call", () => {
    expect(
      estimateGrokContextTokensUsed({
        inputTokens: 183_319,
        outputTokens: 1_275,
        cachedReadTokens: 182_656,
        reasoningTokens: 0,
        totalTokens: 184_594,
        modelCalls: 1,
      }),
    ).toBe(183_319);
  });

  it("averages billed input across in-turn model calls", () => {
    expect(
      estimateGrokContextTokensUsed({
        inputTokens: 813_282,
        outputTokens: 12_043,
        cachedReadTokens: 754_432,
        reasoningTokens: 8_966,
        totalTokens: 825_325,
        modelCalls: 16,
      }),
    ).toBe(Math.round(813_282 / 16));
  });
});

describe("extractGrokContextWindow", () => {
  it("reads ACP usage_update fields", () => {
    expect(extractGrokContextWindow({ used: 12_000, size: 500_000 })).toEqual({
      usedTokens: 12_000,
      maxTokens: 500_000,
    });
  });

  it("reads signals.json and session/usage field names", () => {
    expect(
      extractGrokContextWindow({
        contextTokensUsed: 74_838,
        contextWindowTokens: 500_000,
      }),
    ).toEqual({
      usedTokens: 74_838,
      maxTokens: 500_000,
    });
    expect(
      extractGrokContextWindow({
        usage: { tokensUsed: 20_629, contextWindowTokens: 500_000 },
      }),
    ).toEqual({
      usedTokens: 20_629,
      maxTokens: 500_000,
    });
  });
});

describe("snapshotFromGrokTurnUsage", () => {
  it("does not treat billed turn input as occupancy when many model calls ran", () => {
    const snapshot = snapshotFromGrokTurnUsage({
      modelId: "grok-4.6-build",
      usage: {
        inputTokens: 813_282,
        outputTokens: 12_043,
        totalTokens: 825_325,
        cachedReadTokens: 754_432,
        reasoningTokens: 8_966,
        modelCalls: 16,
        apiDurationMs: 184_025,
      },
    });

    expect(snapshot?.usedTokens).toBe(Math.round(813_282 / 16));
    expect(snapshot?.maxTokens).toBe(500_000);
    expect(snapshot?.totalProcessedTokens).toBe(825_325);
    expect(snapshot?.compactsAutomatically).toBe(true);
    expect(snapshot?.usedTokens).toBeLessThan(500_000);
  });

  it("prefers explicit occupancy when the payload carries it", () => {
    const snapshot = snapshotFromGrokTurnUsage({
      modelId: "grok-4.6-build",
      usage: {
        inputTokens: 813_282,
        outputTokens: 12_043,
        totalTokens: 825_325,
        modelCalls: 16,
      },
      occupancy: { usedTokens: 74_838, maxTokens: 500_000 },
    });

    expect(snapshot?.usedTokens).toBe(74_838);
    expect(snapshot?.maxTokens).toBe(500_000);
  });
});

describe("xAI session update parsing", () => {
  it("unwraps _x.ai/session/update turn_completed payloads", () => {
    const parsed = unwrapXAiSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "turn_completed",
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, modelCalls: 1 },
      },
    });

    expect(parsed?.sessionUpdate).toBe("turn_completed");
    expect(parsed?.sessionId).toBe("session-1");
  });

  it("maps turn_completed and compact events to snapshots", () => {
    const turn = snapshotFromXAiSessionUpdate({
      modelId: "grok-4.6",
      payload: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "turn_completed",
          usage: {
            inputTokens: 183_319,
            outputTokens: 1_275,
            totalTokens: 184_594,
            cachedReadTokens: 182_656,
            modelCalls: 1,
          },
        },
      },
    });
    expect(turn?.usedTokens).toBe(183_319);
    expect(turn?.maxTokens).toBe(500_000);

    const compact = snapshotFromXAiSessionUpdate({
      modelId: "grok-4.6",
      payload: {
        update: {
          sessionUpdate: "auto_compact_completed",
          tokens_after: 40_000,
          context_window: 500_000,
        },
      },
    });
    expect(compact?.usedTokens).toBe(40_000);
    expect(compact?.maxTokens).toBe(500_000);
  });
});

describe("parseGrokTurnUsageTotals", () => {
  it("requires a recognisable token payload", () => {
    expect(parseGrokTurnUsageTotals({})).toBeUndefined();
    expect(parseGrokTurnUsageTotals({ inputTokens: 10, modelCalls: 2 })?.modelCalls).toBe(2);
  });
});

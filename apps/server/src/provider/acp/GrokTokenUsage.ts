/**
 * Maps Grok/xAI usage payloads onto the shared thread token-usage snapshot.
 *
 * Grok's billed `turn_completed.usage.inputTokens` is the sum of every model
 * call in the turn, not occupancy. Occupancy comes from ACP `usage_update`,
 * `x.ai/session/usage`, compact events, or an average-per-call estimate.
 *
 * @module GrokTokenUsage
 */
import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

const GROK_DEFAULT_CONTEXT_WINDOW = 500_000;
const GROK_FAST_CONTEXT_WINDOW = 2_000_000;

export const XAI_SESSION_UPDATE_METHODS = ["_x.ai/session/update", "x.ai/session/update"] as const;

export const XAI_SESSION_USAGE_METHODS = ["x.ai/session/usage", "_x.ai/session/usage"] as const;

export function resolveGrokHomePath(environment?: NodeJS.ProcessEnv): string {
  const override = environment?.GROK_HOME?.trim() || process.env.GROK_HOME?.trim();
  if (override) {
    return override;
  }
  const home = environment?.HOME?.trim() || process.env.HOME?.trim() || "";
  return home.length > 0 ? `${home}/.grok` : ".grok";
}

export function resolveGrokSignalsFilePath(input: {
  readonly grokHome: string;
  readonly cwd: string;
  readonly sessionId: string;
}): string {
  return `${input.grokHome.replace(/\/+$/, "")}/sessions/${encodeURIComponent(input.cwd)}/${input.sessionId}/signals.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value);
}

function finitePositiveInteger(value: unknown): number | undefined {
  const parsed = finiteNonNegativeInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function firstFiniteNonNegativeInteger(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | undefined {
  for (const key of keys) {
    const parsed = finiteNonNegativeInteger(record[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function firstFinitePositiveInteger(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | undefined {
  for (const key of keys) {
    const parsed = finitePositiveInteger(record[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Known Grok coding-model windows. Custom or unknown slugs omit a max so the
 * meter can still show used tokens without inventing a percentage.
 */
export function resolveGrokModelContextWindow(
  modelId: string | null | undefined,
): number | undefined {
  const slug = modelId?.trim().toLowerCase();
  if (!slug) {
    return GROK_DEFAULT_CONTEXT_WINDOW;
  }
  if (slug.includes("fast") && slug.includes("grok-4")) {
    return GROK_FAST_CONTEXT_WINDOW;
  }
  if (
    slug === "grok-build" ||
    slug.startsWith("grok-build") ||
    slug.startsWith("grok-4.6") ||
    slug.startsWith("grok-4.5")
  ) {
    return GROK_DEFAULT_CONTEXT_WINDOW;
  }
  return undefined;
}

export function makeThreadTokenUsageSnapshot(input: {
  readonly usedTokens: number;
  readonly maxTokens?: number;
  readonly totalProcessedTokens?: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly lastUsedTokens?: number;
  readonly lastInputTokens?: number;
  readonly lastCachedInputTokens?: number;
  readonly lastOutputTokens?: number;
  readonly lastReasoningOutputTokens?: number;
  readonly durationMs?: number;
  readonly compactsAutomatically?: boolean;
}): ThreadTokenUsageSnapshot | undefined {
  const usedTokens = finiteNonNegativeInteger(input.usedTokens);
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = finitePositiveInteger(input.maxTokens);
  const clampedUsed = maxTokens !== undefined ? Math.min(usedTokens, maxTokens) : usedTokens;
  const totalProcessedTokens = finiteNonNegativeInteger(input.totalProcessedTokens);
  const inputTokens = finiteNonNegativeInteger(input.inputTokens);
  const cachedInputTokens = finiteNonNegativeInteger(input.cachedInputTokens);
  const outputTokens = finiteNonNegativeInteger(input.outputTokens);
  const reasoningOutputTokens = finiteNonNegativeInteger(input.reasoningOutputTokens);
  const lastUsedTokens = finiteNonNegativeInteger(input.lastUsedTokens) ?? clampedUsed;
  const lastInputTokens = finiteNonNegativeInteger(input.lastInputTokens);
  const lastCachedInputTokens = finiteNonNegativeInteger(input.lastCachedInputTokens);
  const lastOutputTokens = finiteNonNegativeInteger(input.lastOutputTokens);
  const lastReasoningOutputTokens = finiteNonNegativeInteger(input.lastReasoningOutputTokens);
  const durationMs = finiteNonNegativeInteger(input.durationMs);

  return {
    usedTokens: clampedUsed,
    lastUsedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > clampedUsed
      ? { totalProcessedTokens }
      : {}),
    ...(inputTokens !== undefined && inputTokens > 0 ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined && cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined && outputTokens > 0 ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined && reasoningOutputTokens > 0
      ? { reasoningOutputTokens }
      : {}),
    ...(lastInputTokens !== undefined ? { lastInputTokens } : {}),
    ...(lastCachedInputTokens !== undefined ? { lastCachedInputTokens } : {}),
    ...(lastOutputTokens !== undefined ? { lastOutputTokens } : {}),
    ...(lastReasoningOutputTokens !== undefined ? { lastReasoningOutputTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(input.compactsAutomatically !== undefined
      ? { compactsAutomatically: input.compactsAutomatically }
      : {}),
  };
}

/**
 * Pulls occupancy (`used`) and window size (`max`) from the shapes Grok and
 * ACP actually emit. Nested objects are searched one level so a
 * `{ usage: { tokensUsed, contextWindowTokens } }` RPC result still matches.
 */
export function extractGrokContextWindow(value: unknown): {
  readonly usedTokens?: number;
  readonly maxTokens?: number;
} {
  if (!isRecord(value)) {
    return {};
  }

  const usedTokens = firstFiniteNonNegativeInteger(value, [
    "used",
    "usedTokens",
    "tokensUsed",
    "contextTokensUsed",
    "tokens_used",
    "tokens_after",
  ]);
  const maxTokens = firstFinitePositiveInteger(value, [
    "size",
    "maxTokens",
    "contextWindowTokens",
    "contextWindow",
    "context_window",
    "context_window_tokens",
  ]);
  if (usedTokens !== undefined || maxTokens !== undefined) {
    return {
      ...(usedTokens !== undefined ? { usedTokens } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    };
  }

  for (const nestedKey of ["usage", "result", "context", "contextUsage", "data"] as const) {
    const nested = value[nestedKey];
    if (!isRecord(nested)) {
      continue;
    }
    const extracted = extractGrokContextWindow(nested);
    if (extracted.usedTokens !== undefined || extracted.maxTokens !== undefined) {
      return extracted;
    }
  }

  return {};
}

export interface GrokTurnUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedReadTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly modelCalls: number;
  readonly durationMs?: number;
}

export function parseGrokTurnUsageTotals(value: unknown): GrokTurnUsageTotals | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputTokens = finiteNonNegativeInteger(value.inputTokens) ?? 0;
  const outputTokens = finiteNonNegativeInteger(value.outputTokens) ?? 0;
  const cachedReadTokens = finiteNonNegativeInteger(value.cachedReadTokens) ?? 0;
  const reasoningTokens =
    finiteNonNegativeInteger(value.reasoningTokens) ??
    finiteNonNegativeInteger(value.thoughtTokens) ??
    0;
  const totalTokens = finiteNonNegativeInteger(value.totalTokens) ?? inputTokens + outputTokens;
  const modelCalls = Math.max(
    1,
    finitePositiveInteger(value.modelCalls) ?? finitePositiveInteger(value.numTurns) ?? 1,
  );
  const durationMs = finiteNonNegativeInteger(value.apiDurationMs);
  if (inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    cachedReadTokens,
    reasoningTokens,
    totalTokens,
    modelCalls,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** Average per model call approximates last-request occupancy. */
export function estimateGrokContextTokensUsed(usage: GrokTurnUsageTotals): number {
  if (usage.modelCalls <= 1) {
    return usage.inputTokens > 0 ? usage.inputTokens : usage.totalTokens;
  }
  const perCall = Math.round(usage.inputTokens / usage.modelCalls);
  return perCall > 0 ? perCall : Math.round(usage.totalTokens / usage.modelCalls);
}

export function snapshotFromGrokTurnUsage(input: {
  readonly usage: unknown;
  readonly modelId?: string | null | undefined;
  readonly occupancy?: {
    readonly usedTokens?: number;
    readonly maxTokens?: number;
  };
  readonly lastKnownMaxTokens?: number | undefined;
}): ThreadTokenUsageSnapshot | undefined {
  const totals = parseGrokTurnUsageTotals(input.usage);
  const occupancy = input.occupancy ?? extractGrokContextWindow(input.usage);
  const estimatedUsed = totals ? estimateGrokContextTokensUsed(totals) : undefined;
  const usedTokens = occupancy.usedTokens ?? estimatedUsed;
  if (usedTokens === undefined) {
    return undefined;
  }

  const maxTokens =
    occupancy.maxTokens ?? input.lastKnownMaxTokens ?? resolveGrokModelContextWindow(input.modelId);

  const lastInputTokens = totals
    ? totals.modelCalls <= 1
      ? totals.inputTokens
      : Math.round(totals.inputTokens / totals.modelCalls)
    : undefined;
  const lastOutputTokens = totals
    ? totals.modelCalls <= 1
      ? totals.outputTokens
      : Math.round(totals.outputTokens / totals.modelCalls)
    : undefined;
  const lastCachedInputTokens = totals
    ? totals.modelCalls <= 1
      ? totals.cachedReadTokens
      : Math.round(totals.cachedReadTokens / totals.modelCalls)
    : undefined;
  const lastReasoningOutputTokens = totals
    ? totals.modelCalls <= 1
      ? totals.reasoningTokens
      : Math.round(totals.reasoningTokens / totals.modelCalls)
    : undefined;

  return makeThreadTokenUsageSnapshot({
    usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(totals !== undefined && totals.totalTokens > usedTokens
      ? { totalProcessedTokens: totals.totalTokens }
      : {}),
    ...(lastInputTokens !== undefined ? { inputTokens: lastInputTokens } : {}),
    ...(lastCachedInputTokens !== undefined ? { cachedInputTokens: lastCachedInputTokens } : {}),
    ...(lastOutputTokens !== undefined ? { outputTokens: lastOutputTokens } : {}),
    ...(lastReasoningOutputTokens !== undefined
      ? { reasoningOutputTokens: lastReasoningOutputTokens }
      : {}),
    lastUsedTokens: usedTokens,
    ...(lastInputTokens !== undefined ? { lastInputTokens } : {}),
    ...(lastCachedInputTokens !== undefined ? { lastCachedInputTokens } : {}),
    ...(lastOutputTokens !== undefined ? { lastOutputTokens } : {}),
    ...(lastReasoningOutputTokens !== undefined ? { lastReasoningOutputTokens } : {}),
    ...(totals?.durationMs !== undefined ? { durationMs: totals.durationMs } : {}),
    compactsAutomatically: true,
  });
}

export interface ParsedXAiSessionUpdate {
  readonly sessionId?: string;
  readonly sessionUpdate: string;
  readonly update: Record<string, unknown>;
}

export function unwrapXAiSessionUpdate(payload: unknown): ParsedXAiSessionUpdate | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const nestedParams = isRecord(payload.params) ? payload.params : undefined;
  const record = nestedParams ?? payload;
  const update = isRecord(record.update) ? record.update : undefined;
  if (!update) {
    return undefined;
  }

  const sessionUpdate =
    typeof update.sessionUpdate === "string"
      ? update.sessionUpdate
      : typeof update.session_update === "string"
        ? update.session_update
        : undefined;
  if (!sessionUpdate) {
    return undefined;
  }

  const sessionId =
    typeof record.sessionId === "string"
      ? record.sessionId
      : typeof payload.sessionId === "string"
        ? payload.sessionId
        : undefined;

  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    sessionUpdate,
    update,
  };
}

export function snapshotFromXAiSessionUpdate(input: {
  readonly payload: unknown;
  readonly modelId?: string | null | undefined;
  readonly lastKnownMaxTokens?: number | undefined;
}): ThreadTokenUsageSnapshot | undefined {
  const parsed = unwrapXAiSessionUpdate(input.payload);
  if (!parsed) {
    return extractGrokContextWindow(input.payload).usedTokens !== undefined ||
      extractGrokContextWindow(input.payload).maxTokens !== undefined
      ? snapshotFromGrokTurnUsage({
          usage: input.payload,
          modelId: input.modelId,
          lastKnownMaxTokens: input.lastKnownMaxTokens,
        })
      : undefined;
  }

  switch (parsed.sessionUpdate) {
    case "turn_completed":
      return snapshotFromGrokTurnUsage({
        usage: parsed.update.usage,
        occupancy: extractGrokContextWindow(parsed.update),
        modelId: input.modelId,
        lastKnownMaxTokens: input.lastKnownMaxTokens,
      });
    case "auto_compact_started":
    case "auto_compact_completed":
      return snapshotFromGrokTurnUsage({
        usage: parsed.update,
        occupancy: extractGrokContextWindow(parsed.update),
        modelId: input.modelId,
        lastKnownMaxTokens: input.lastKnownMaxTokens,
      });
    default:
      return undefined;
  }
}

export function tokenUsageSnapshotsEqual(
  left: ThreadTokenUsageSnapshot | undefined,
  right: ThreadTokenUsageSnapshot | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.usedTokens === right.usedTokens &&
    left.maxTokens === right.maxTokens &&
    left.totalProcessedTokens === right.totalProcessedTokens
  );
}

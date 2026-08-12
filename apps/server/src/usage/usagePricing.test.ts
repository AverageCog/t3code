import { describe, expect, it } from "@effect/vitest";

import { lookupRate, parseRateTable, priceUsage, withLocalFallbackRates } from "./usagePricing.ts";

describe("lookupRate", () => {
  const table = parseRateTable({
    "xai/grok-4.5": {
      input_cost_per_token: 2e-6,
      output_cost_per_token: 6e-6,
      cache_read_input_token_cost: 3e-7,
    },
  });

  it("strips a provider prefix", () => {
    expect(lookupRate(table, "xai/grok-4.5")?.inputCostPerToken).toBe(2e-6);
  });

  it("matches Grok CLI *-build variants to the published base model", () => {
    expect(lookupRate(table, "grok-4.5-build")?.outputCostPerToken).toBe(6e-6);
  });

  it("does not invent a rate for an unknown model", () => {
    expect(lookupRate(table, "not-a-real-model")).toBeNull();
  });

  it("fills in grok-4.6 when LiteLLM has no row", () => {
    const rate = lookupRate(withLocalFallbackRates(table), "grok-4.6-build");
    expect(rate).toEqual({
      inputCostPerToken: 2e-6,
      outputCostPerToken: 6e-6,
      cacheReadCostPerToken: 5e-7,
      cacheCreationCostPerToken: 2e-6,
    });
  });

  it("lets a LiteLLM grok-4.6 row replace the local fallback", () => {
    const withLiteLlm = withLocalFallbackRates(
      parseRateTable({
        "xai/grok-4.6": {
          input_cost_per_token: 9e-6,
          output_cost_per_token: 8e-6,
          cache_read_input_token_cost: 1e-7,
        },
      }),
    );
    expect(lookupRate(withLiteLlm, "grok-4.6-build")?.inputCostPerToken).toBe(9e-6);
  });
});

describe("priceUsage", () => {
  const table = parseRateTable({
    "grok-4.5": {
      input_cost_per_token: 2e-6,
      output_cost_per_token: 6e-6,
      cache_read_input_token_cost: 3e-7,
    },
  });
  const totals = {
    uncachedInputTokens: 100,
    cachedInputTokens: 50,
    cacheCreationTokens: 0,
    outputTokens: 10,
    reasoningTokens: 4,
  };

  it("prefers a provider-reported cost over the rate table", () => {
    expect(priceUsage(table, "grok-4.5-build", totals, 0.12)).toEqual({
      costUsd: 0.12,
      costSource: "providerReported",
    });
  });

  it("prices a Grok build variant from the base model rates", () => {
    const priced = priceUsage(table, "grok-4.5-build", totals, null);
    expect(priced.costSource).toBe("modelPriced");
    expect(priced.costUsd).toBeCloseTo(100 * 2e-6 + 50 * 3e-7 + 10 * 6e-6, 12);
  });

  it("prices grok-4.6 from the short-context fallback", () => {
    const priced = priceUsage(
      withLocalFallbackRates(parseRateTable({})),
      "grok-4.6-build",
      totals,
      null,
    );
    expect(priced.costSource).toBe("modelPriced");
    expect(priced.costUsd).toBeCloseTo(100 * 2e-6 + 50 * 5e-7 + 10 * 6e-6, 12);
  });
});

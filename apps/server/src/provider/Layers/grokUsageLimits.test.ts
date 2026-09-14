import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { grokBillingToUsageLimits, readGrokUsageLimits } from "./grokUsageLimits.ts";

const checkedAt = "2026-09-14T00:00:00.000Z";
const weekly = {
  config: {
    creditUsagePercent: 42.5,
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-09-14T00:00:00Z",
      end: "2026-09-21T00:00:00Z",
    },
  },
};

describe("Grok subscription limits", () => {
  it("maps the shared weekly allowance and reset, preferring it over legacy credits", () => {
    expect(
      grokBillingToUsageLimits(
        { config: { ...weekly.config, monthlyLimit: { val: 100 }, used: { val: 99 } } },
        checkedAt,
      ).windows,
    ).toEqual([
      {
        id: "included",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 42.5,
        resetsAt: "2026-09-21T00:00:00.000Z",
        windowDurationMins: 10080,
      },
    ]);
  });
  it("supports legacy monthly credits including omitted zero scalars", () => {
    expect(
      grokBillingToUsageLimits({ config: { monthlyLimit: { val: 2000 }, used: {} } }, checkedAt)
        .windows[0],
    ).toMatchObject({ kind: "monthly", usedPercent: 0 });
    expect(
      grokBillingToUsageLimits(
        { config: { monthlyLimit: { val: 2000 }, used: { val: 500 } } },
        checkedAt,
      ).windows[0]?.usedPercent,
    ).toBe(25);
  });
  it("does not invent allowance or reset data", () => {
    for (const config of [null, {}, { monthlyLimit: {} }, { monthlyLimit: { val: 0 } }]) {
      expect(grokBillingToUsageLimits({ config }, checkedAt).unavailable?.reason).toBe(
        "probeFailed",
      );
    }
    expect(
      grokBillingToUsageLimits(
        { config: { creditUsagePercent: 120, currentPeriod: { type: "NEW_PERIOD", end: "bad" } } },
        checkedAt,
      ).windows[0],
    ).toEqual({ id: "included", kind: "other", label: "Included usage", usedPercent: 100 });
  });
  it.effect("reads billing using cached auth without creating a session or prompting", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const limits = yield* readGrokUsageLimits(
        {
          request: (method, payload) => {
            requests.push(method);
            if (method === "authenticate") expect(payload).toEqual({ methodId: "cached_token" });
            return Effect.succeed(method === "authenticate" ? {} : weekly);
          },
        },
        checkedAt,
      );
      expect(requests).toEqual(["authenticate", "_x.ai/billing"]);
      expect(limits.windows[0]?.usedPercent).toBe(42.5);
    }),
  );
  it.effect("turns malformed billing into an unavailable snapshot", () =>
    Effect.gen(function* () {
      const limits = yield* readGrokUsageLimits(
        { request: () => Effect.succeed({ secret: "not for display" }) },
        checkedAt,
      );
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(limits.unavailable?.message).not.toContain("not for display");
    }),
  );
});

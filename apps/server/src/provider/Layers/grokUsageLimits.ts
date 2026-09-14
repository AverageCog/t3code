import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { AcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const Cent = Schema.Struct({ val: Schema.optional(Schema.Finite) });
// Wire shape from xai-org/grok-build's extensions/billing.rs.
const BillingResponse = Schema.Struct({
  config: Schema.NullOr(
    Schema.Struct({
      creditUsagePercent: Schema.optional(Schema.NullOr(Schema.Finite)),
      currentPeriod: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            type: Schema.optional(Schema.String),
            start: Schema.optional(Schema.String),
            end: Schema.optional(Schema.String),
          }),
        ),
      ),
      monthlyLimit: Schema.optional(Schema.NullOr(Cent)),
      used: Schema.optional(Schema.NullOr(Cent)),
      billingPeriodStart: Schema.optional(Schema.NullOr(Schema.String)),
      billingPeriodEnd: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
const decodeBillingResponse = Schema.decodeUnknownSync(BillingResponse);

function timestamp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

export function grokBillingToUsageLimits(
  value: unknown,
  checkedAt: string,
): ServerProviderUsageLimits {
  const { config } = decodeBillingResponse(value);
  const percent =
    config?.creditUsagePercent ??
    (config?.monthlyLimit?.val !== undefined && config.monthlyLimit.val > 0 && config.used
      ? ((config.used.val ?? 0) / config.monthlyLimit.val) * 100
      : undefined);
  if (percent === undefined || !Number.isFinite(percent)) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Grok did not report an included subscription allowance.",
    });
  }
  const period = config?.currentPeriod;
  const kind =
    period?.type === "USAGE_PERIOD_TYPE_WEEKLY"
      ? "weekly"
      : period?.type === "USAGE_PERIOD_TYPE_MONTHLY" || (!period && config?.monthlyLimit)
        ? "monthly"
        : "other";
  const start = timestamp(period ? period.start : config?.billingPeriodStart);
  const end = timestamp(period ? period.end : config?.billingPeriodEnd);
  const duration = start && end ? (Date.parse(end) - Date.parse(start)) / 60_000 : 0;
  return makeUsageLimits({
    checkedAt,
    windows: [
      {
        id: "included",
        kind,
        label: kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Included usage",
        usedPercent: clampPercent(percent),
        ...(end ? { resetsAt: end } : {}),
        ...(duration >= 1 ? { windowDurationMins: Math.round(duration) } : {}),
      },
    ],
  });
}

/** Cached-token auth cannot start a login flow; no session or prompt is created. */
export const readGrokUsageLimits = Effect.fn("readGrokUsageLimits")(function* (
  acp: Pick<AcpSessionRuntime["Service"], "request">,
  checkedAt: string,
) {
  return yield* Effect.gen(function* () {
    yield* acp.request("authenticate", { methodId: "cached_token" });
    const response = yield* acp.request("_x.ai/billing", {});
    return yield* Effect.try(() => grokBillingToUsageLimits(response, checkedAt));
  }).pipe(
    Effect.timeout("20 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Could not read Grok subscription limits. Check your Grok CLI login and version.",
      }),
    ),
  );
});

import {
  expectedSubscriptionProvider,
  type SubscriptionUsageStatus,
} from "@t3tools/client-runtime/state/subscription-usage";
import type { SubscriptionUsageProvider, UsageProviderKind } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { useSubscriptionUsage } from "../../state/usage";
import {
  subscriptionPlanLabel,
  subscriptionProviderName,
  subscriptionUnavailableMessage,
  subscriptionWindowLabel,
} from "../usage/subscriptionFormat";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";

/** History-chart kind for a subscription provider; the only consumer of the mapping. */
function subscriptionHistoryKind(provider: SubscriptionUsageProvider): UsageProviderKind {
  return provider === "claude" ? "claude" : provider === "grok" ? "grok" : "codex";
}

/**
 * Hover summary shown above the sidebar's Usage button: the same per-account
 * subscription limits the usage page's Subscriptions tab reports, collapsed
 * to one bar per window. Read-only, so it keeps the tooltip's default
 * pointer-events-none and closes as soon as the cursor leaves the button.
 */
export const UsageSubscriptionPeek = memo(function UsageSubscriptionPeek() {
  const { environments, statuses, isPending, isPartial } = useSubscriptionUsage();

  return (
    <div className="flex w-fit min-w-64 max-w-[min(22rem,calc(100vw-2rem))] flex-col gap-3 py-1 text-left">
      <h2 className="px-1 text-xs font-semibold text-popover-foreground">Subscription limits</h2>
      {isPending ? (
        <p className="px-1 text-xs text-muted-foreground">Waiting for connected environments…</p>
      ) : statuses.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">
          No supported provider configured. Enable Codex, Claude, or Grok and sign in.
        </p>
      ) : (
        <div className="flex flex-col gap-3 [&>section:not(:first-child)]:border-t [&>section:not(:first-child)]:pt-3">
          {statuses.map((status) => (
            <PeekAccount key={status.accountKey} status={status} />
          ))}
        </div>
      )}
      {(isPartial || environments.some((environment) => environment.error !== null)) &&
      statuses.length > 0 ? (
        <p className="border-t border-border px-1 pt-2 text-[11px] text-muted-foreground">
          Some connected environments could not report subscription limits.
        </p>
      ) : null}
    </div>
  );
});

function PeekAccount({ status }: { readonly status: SubscriptionUsageStatus }) {
  const { provider } = status;
  const expected = expectedSubscriptionProvider(provider);
  const usage =
    expected !== undefined && provider.subscriptionUsage?.provider === expected
      ? provider.subscriptionUsage
      : null;
  const Mark = PROVIDER_PRESENTATION[expected ? subscriptionHistoryKind(expected) : "codex"].mark;

  return (
    <section className="flex flex-col gap-2 px-1">
      <div className="flex items-baseline gap-2">
        <Mark aria-hidden className="size-4 shrink-0 self-center" />
        <span className="min-w-0 truncate text-xs font-medium text-popover-foreground">
          {expected
            ? subscriptionProviderName(expected)
            : (provider.displayName ?? provider.instanceId)}
        </span>
        {usage ? (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {subscriptionPlanLabel(usage.provider, usage.plan, provider.auth.label)}
          </span>
        ) : null}
      </div>
      {usage && usage.windows.length > 0 ? (
        usage.windows.map((window) => {
          const remainingPercent = Math.max(0, 100 - window.usedPercent);
          return (
            <div
              key={`${window.kind}:${window.scope?.type ?? "overall"}:${window.scope?.id ?? "all"}`}
            >
              <div className="flex items-baseline justify-between gap-3 text-[11px]">
                <span className="min-w-0 truncate text-muted-foreground">
                  {subscriptionWindowLabel(window)}
                </span>
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    window.usedPercent >= 90 ? "text-destructive" : "text-popover-foreground",
                  )}
                >
                  {remainingPercent.toLocaleString(undefined, { maximumFractionDigits: 1 })}% left
                </span>
              </div>
              <div
                aria-label={subscriptionWindowLabel(window)}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={remainingPercent}
                role="progressbar"
                className="mt-1 h-1 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className={cn(
                    "h-full rounded-full",
                    window.usedPercent >= 90 ? "bg-destructive" : "bg-foreground",
                  )}
                  style={{ width: `${Math.min(100, window.usedPercent)}%` }}
                />
              </div>
            </div>
          );
        })
      ) : (
        <p className="text-[11px] leading-4 text-muted-foreground">
          {subscriptionUnavailableMessage(provider)}
        </p>
      )}
    </section>
  );
}

import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
} from "@t3tools/shared/usageLimits";
import { memo, useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { getDriverOption } from "../settings/providerDriverMeta";
import { barColor } from "../usage/UsageLimits";

/** Read-only summary of the same pooled accounts shown in the Limits tab. */
export const UsageSubscriptionPeek = memo(function UsageSubscriptionPeek() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [now] = useState(Date.now);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const notices = collectLimitNotices(presentations);
  const pending = [...presentations.values()].some((entry) => entry.serverConfig === null);

  return (
    <div className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 py-1 text-left">
      <h2 className="text-xs font-semibold">Subscription limits</h2>
      {pools.length === 0 && notices.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {pending
            ? "Waiting for connected environments…"
            : "No provider reports subscription limits."}
        </p>
      ) : null}
      {pools.map((pool) => (
        <section key={pool.driver} className="flex flex-col gap-2">
          <h3 className="text-xs font-medium">
            {getDriverOption(pool.driver)?.label ?? pool.driver}
          </h3>
          {displayLimitWindows(pool).map((window) => {
            const label =
              (pool.driver === "cursor" ? cursorUsageWindowDetails(window.id)?.label : undefined) ??
              window.label;
            return (
              <div key={`${window.kind}:${window.id}`}>
                <div className="flex justify-between gap-3 text-2xs">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="tabular-nums">{window.remainingPercent}% left</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={`${pool.driver} ${label} remaining`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={window.remainingPercent}
                  className="mt-1 h-1 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${window.remainingPercent}%`,
                      backgroundColor: barColor(pool.driver),
                    }}
                  />
                </div>
              </div>
            );
          })}
        </section>
      ))}
      {notices.map((notice) => (
        <p key={notice} className="text-2xs text-muted-foreground">
          {notice}
        </p>
      ))}
      {pending && pools.length > 0 ? (
        <p className="text-2xs text-muted-foreground">Some environments are still loading.</p>
      ) : null}
    </div>
  );
});

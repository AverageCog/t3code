import {
  expectedSubscriptionProvider,
  scrambleSubscriptionEmail,
  type SubscriptionEnvironmentUsageStatus,
  type SubscriptionUsageStatus,
} from "@t3tools/client-runtime/state/subscription-usage";
import type { UsageProviderKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { CheckIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { DailyTotals, HourlyTotals, MergedUsage } from "@t3tools/shared/usageMerge";

import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { useSubscriptionUsage, useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
  DEFAULT_USAGE_PAGE_SELECTION,
  USAGE_PAGE_SELECTIONS,
  type UsageHistoryDays,
} from "@t3tools/shared/usageFormat";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  subscriptionPlanLabel,
  subscriptionProviderName,
  subscriptionResetLabel,
  subscriptionUnavailableMessage,
  subscriptionWindowLabel,
} from "./subscriptionFormat";
import { UsageProviderChart, type UsageChartMetric } from "./UsageProviderChart";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders";

const WINDOW_OPTIONS = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

const USAGE_PAGE_SELECTION_STORAGE_KEY = "t3code:usage-page-selection:v1";
const UsagePageSelectionSchema = Schema.Literals(USAGE_PAGE_SELECTIONS);

export function UsagePage() {
  const [usageSelection, setUsageSelection] = useLocalStorage(
    USAGE_PAGE_SELECTION_STORAGE_KEY,
    DEFAULT_USAGE_PAGE_SELECTION,
    UsagePageSelectionSchema,
  );
  const activeView = usageSelection === "subscriptions" ? "subscriptions" : "history";
  const [windowSelection, setWindowSelection] = useState(() => {
    const days = usageSelection === "subscriptions" ? DEFAULT_USAGE_PAGE_SELECTION : usageSelection;
    return {
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    };
  });
  const [subscriptionWindow, setSubscriptionWindow] = useState(() => makeWindow(30));
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const [breakdown, setBreakdown] = useState<"model" | "time">("model");
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const { merged, environments, isPending, isPartial, refresh } = useUsage(
    window,
    activeView === "history",
  );
  const subscriptionHistory = useUsage(subscriptionWindow, activeView === "subscriptions");
  const subscriptions = useSubscriptionUsage();

  useEffect(() => {
    if (usageSelection === "subscriptions" || usageSelection === windowSelection.days) return;
    setWindowSelection({
      days: usageSelection,
      window: makeWindow(usageSelection, undefined, usageSelection === 1 ? "hour" : "day"),
    });
  }, [usageSelection, windowSelection.days]);

  // Hold the content until every environment is terminal. Rendering merged
  // totals while devices are still answering makes every number on the page
  // jump as each one lands.
  const settling = isPending || isPartial;

  const days = useMemo(
    () => enumerateDays(window.sinceDay, window.untilDay),
    [window.sinceDay, window.untilDay],
  );
  const hours = useMemo(
    () =>
      window.sinceTime === undefined || window.untilTime === undefined
        ? []
        : enumerateHourStarts(window.sinceTime, window.untilTime),
    [window.sinceTime, window.untilTime],
  );
  // Newest first: the window can run 90 periods, so the interesting end
  // belongs at the top of the table.
  const breakdownPeriods = useMemo<readonly (DailyTotals | HourlyTotals)[]>(
    () => (isPast24Hours ? merged.hourly : merged.daily).toReversed(),
    [isPast24Hours, merged.daily, merged.hourly],
  );
  const activeProviders = useMemo(() => providersWithUsage(merged.providers), [merged.providers]);
  const timeValueColumnWidth = `${60 / (activeProviders.length + 2)}%`;

  const selectWindow = (days: UsageHistoryDays) => {
    setUsageSelection(days);
    setWindowSelection({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const refreshWindow = () => {
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    if (
      nextWindow.sinceDay === window.sinceDay &&
      nextWindow.untilDay === window.untilDay &&
      nextWindow.sinceTime === window.sinceTime &&
      nextWindow.untilTime === window.untilTime
    ) {
      refresh();
    } else {
      setWindowSelection({ days: windowDays, window: nextWindow });
    }
  };
  const refreshPage = () => {
    if (activeView === "subscriptions") {
      void subscriptions.refresh();
      const nextWindow = makeWindow(30);
      if (
        nextWindow.sinceDay === subscriptionWindow.sinceDay &&
        nextWindow.untilDay === subscriptionWindow.untilDay
      ) {
        subscriptionHistory.refresh();
      } else {
        setSubscriptionWindow(nextWindow);
      }
      return;
    }
    refreshWindow();
  };
  const windowLabel =
    activeView === "subscriptions"
      ? "Subscription limits"
      : isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
        ? `${formatDateTimeShort(window.sinceTime, window.timeZone)} to ${formatDateTimeShort(window.untilTime, window.timeZone)}`
        : `${formatDayShort(window.sinceDay)} to ${formatDayShort(window.untilDay)}`;
  const topbarContent = (
    <div className="flex w-full min-w-0 items-center gap-3">
      <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem current>
          <h1>Usage</h1>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator className="hidden md:flex" />
        <WorkspaceBreadcrumbItem className="hidden min-w-0 shrink md:flex">
          <span className="truncate">{windowLabel}</span>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <div className="ms-auto hidden min-w-0 items-center justify-end gap-2 lg:flex">
        {activeView === "history" ? (
          <ToggleGroup
            aria-label="Usage metric"
            variant="segmented"
            value={[metric]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "cost" || value === "tokens") setMetric(value);
            }}
          >
            {(["cost", "tokens"] as const).map((option) => (
              <Toggle key={option} value={option}>
                {option === "cost" ? "Cost" : "Tokens"}
              </Toggle>
            ))}
          </ToggleGroup>
        ) : null}
        <ToggleGroup
          aria-label="Usage period"
          variant="segmented"
          value={[String(usageSelection)]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "subscriptions") {
              setUsageSelection(value);
              return;
            }
            const option = WINDOW_OPTIONS.find((candidate) => String(candidate.days) === value);
            if (option) selectWindow(option.days);
          }}
        >
          {WINDOW_OPTIONS.map((option) => (
            <Toggle key={option.days} value={String(option.days)}>
              {option.label}
            </Toggle>
          ))}
          <Toggle value="subscriptions">Subscriptions</Toggle>
        </ToggleGroup>
        <Button
          onClick={refreshPage}
          aria-label={
            activeView === "subscriptions" ? "Refresh subscription usage" : "Refresh usage"
          }
          size="icon-sm"
          variant="ghost"
          disabled={activeView === "subscriptions" && subscriptions.isRefreshing}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <div className="ms-auto flex min-w-0 items-center justify-end gap-1 lg:hidden">
        {activeView === "history" ? (
          <Select
            value={metric}
            onValueChange={(value) => {
              if (value === "cost" || value === "tokens") setMetric(value);
            }}
          >
            <SelectTrigger
              aria-label="Usage metric"
              size="compact"
              variant="ghost"
              className="w-auto min-w-0"
            >
              <SelectValue>{metric === "cost" ? "Cost" : "Tokens"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="cost">Cost</SelectItem>
              <SelectItem value="tokens">Tokens</SelectItem>
            </SelectPopup>
          </Select>
        ) : null}
        <Select
          value={String(usageSelection)}
          onValueChange={(value) => {
            if (value === "subscriptions") {
              setUsageSelection(value);
              return;
            }
            const option = WINDOW_OPTIONS.find((candidate) => String(candidate.days) === value);
            if (option) selectWindow(option.days);
          }}
        >
          <SelectTrigger
            aria-label="Usage period"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>
              {WINDOW_OPTIONS.find((option) => option.days === windowDays)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {WINDOW_OPTIONS.map((option) => (
              <SelectItem key={option.days} value={String(option.days)}>
                {option.label}
              </SelectItem>
            ))}
            <SelectItem value="subscriptions">Subscriptions</SelectItem>
          </SelectPopup>
        </Select>
        <Button
          onClick={refreshPage}
          aria-label={
            activeView === "subscriptions" ? "Refresh subscription usage" : "Refresh usage"
          }
          size="icon-sm"
          variant="ghost"
          disabled={activeView === "subscriptions" && subscriptions.isRefreshing}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{topbarContent}</WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {activeView === "subscriptions" ? (
              <SubscriptionUsagePanel
                environments={subscriptions.environments}
                statuses={subscriptions.statuses}
                isPending={subscriptions.isPending}
                history={subscriptionHistory.merged}
                historyDay={subscriptionWindow.untilDay}
                isHistoryPending={subscriptionHistory.isPending || subscriptionHistory.isPartial}
                hasHistoryResponse={subscriptionHistory.environments.some(
                  (environment) => environment.summary !== null,
                )}
                isHistoryIncomplete={
                  subscriptionHistory.environments.some(
                    (environment) => environment.error !== null,
                  ) || subscriptionHistory.merged.staleEnvironments.length > 0
                }
              />
            ) : settling ? (
              <>
                {environments.length > 1 ? <UsageDeviceStrip environments={environments} /> : null}
                <UsageSkeleton />
              </>
            ) : (
              <>
                <UsageCoverageNotice
                  environments={environments}
                  duplicateSources={merged.duplicateSources}
                  staleEnvironments={merged.staleEnvironments}
                />

                <section className="grid gap-6 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
                  <div className="flex min-w-0 flex-col gap-5">
                    <div className="flex flex-col gap-1">
                      <span className="text-4xl font-semibold text-foreground tabular-nums">
                        {metric === "cost"
                          ? formatUsd(merged.costUsd)
                          : formatTokens(merged.totalTokens)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {metric === "cost"
                          ? `${formatCount(merged.sessions)} sessions · API estimate`
                          : `${formatCount(merged.sessions)} sessions`}
                      </span>
                    </div>

                    {activeProviders.map((provider) => {
                      const totals = merged.providers.find((entry) => entry.provider === provider);
                      const share =
                        metric === "cost" ? (totals?.costShare ?? 0) : (totals?.tokenShare ?? 0);
                      const providerSessions = totals?.sessions ?? 0;
                      const sessionLabel = `${formatCount(providerSessions)} ${
                        providerSessions === 1 ? "session" : "sessions"
                      }`;
                      return (
                        <div key={provider} className="flex flex-col gap-1">
                          <div className="flex items-baseline justify-between gap-4">
                            <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                              <span
                                aria-hidden
                                className="size-2 shrink-0 rounded-full"
                                style={{
                                  backgroundColor: PROVIDER_PRESENTATION[provider].color,
                                }}
                              />
                              <ProviderMark provider={provider} className="size-4" />
                              <span className="flex min-w-0 items-baseline gap-1.5">
                                <span className="truncate">
                                  {PROVIDER_PRESENTATION[provider].label}
                                </span>
                                <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums">
                                  {sessionLabel}
                                </span>
                              </span>
                            </span>
                            <span className="shrink-0 text-sm font-medium text-foreground tabular-nums">
                              {metric === "cost"
                                ? formatUsd(totals?.costUsd ?? 0)
                                : formatTokens(totals?.totalTokens ?? 0)}
                            </span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {metric === "cost"
                              ? `${formatPercent(share)} of cost · ${formatTokens(totals?.totalTokens ?? 0)} tokens`
                              : `${formatPercent(share)} of tokens · ${formatUsd(totals?.costUsd ?? 0)}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex min-w-0 flex-col gap-3">
                    <h2 className="text-sm font-medium text-foreground">
                      {isPast24Hours ? "Hourly" : "Daily"}{" "}
                      {metric === "tokens" ? "processed tokens" : "cost"}
                    </h2>
                    <UsageProviderChart
                      providers={activeProviders}
                      days={days}
                      daily={merged.daily}
                      hours={hours}
                      hourly={merged.hourly}
                      metric={metric}
                      referenceTime={window.untilTime}
                      resolution={isPast24Hours ? "hour" : "day"}
                      timeZone={window.timeZone}
                    />
                  </div>
                </section>

                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-medium text-foreground">Totals</h2>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
                    <Metric label="Processed tokens" value={formatTokens(merged.totalTokens)} />
                    <Metric label="Cached input" value={formatTokens(merged.cachedInputTokens)} />
                    <Metric
                      label="Uncached input"
                      value={formatTokens(merged.uncachedInputTokens)}
                    />
                    <Metric label="Output" value={formatTokens(merged.outputTokens)} />
                    <Metric
                      label="Cache savings"
                      value={formatUsd(merged.costQuality.cacheSavingsUsd)}
                    />
                  </div>
                </section>

                <section className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
                    <ToggleGroup
                      aria-label="Usage breakdown"
                      variant="segmented"
                      value={[breakdown]}
                      onValueChange={(next) => {
                        const value = next[0];
                        if (value === "model" || value === "time") setBreakdown(value);
                      }}
                    >
                      {(
                        [
                          { value: "model", label: "Model" },
                          { value: "time", label: isPast24Hours ? "Hour" : "Day" },
                        ] as const
                      ).map((option) => (
                        <Toggle key={option.value} value={option.value}>
                          {option.label}
                        </Toggle>
                      ))}
                    </ToggleGroup>
                  </div>

                  {breakdown === "model" ? (
                    <table className="w-full table-fixed text-sm">
                      <colgroup>
                        <col className="w-2/5" />
                        <col className="w-1/5" />
                        <col className="w-1/5" />
                        <col className="w-1/5" />
                      </colgroup>
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-2 font-normal">Model</th>
                          <th className="py-2 text-right font-normal">Cost</th>
                          <th className="py-2 text-right font-normal">Share</th>
                          <th className="py-2 text-right font-normal">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {merged.models.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-6 text-center text-muted-foreground">
                              No activity in this window.
                            </td>
                          </tr>
                        ) : (
                          merged.models.map((model) => (
                            <tr
                              key={`${model.provider}:${model.model}`}
                              className="border-b border-border/50 transition-colors hover:bg-muted/50"
                            >
                              <td className="py-2 text-foreground">
                                <span className="flex items-center gap-2">
                                  <ProviderMark provider={model.provider} className="size-3.5" />
                                  {model.model}
                                </span>
                              </td>
                              <td className="py-2 text-right text-foreground tabular-nums">
                                {formatUsd(model.costUsd)}
                              </td>
                              <td className="py-2 text-right text-muted-foreground tabular-nums">
                                {formatPercent(model.costShare)}
                              </td>
                              <td className="py-2 text-right text-muted-foreground tabular-nums">
                                {formatTokens(model.totalTokens)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  ) : (
                    <table className="w-full table-fixed text-sm">
                      <colgroup>
                        <col className="w-2/5" />
                        {activeProviders.map((provider) => (
                          <col key={provider} style={{ width: timeValueColumnWidth }} />
                        ))}
                        <col style={{ width: timeValueColumnWidth }} />
                        <col style={{ width: timeValueColumnWidth }} />
                      </colgroup>
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-2 font-normal">{isPast24Hours ? "Hour" : "Day"}</th>
                          {activeProviders.map((provider) => (
                            <th key={provider} className="py-2 text-right font-normal">
                              {PROVIDER_PRESENTATION[provider].label}
                            </th>
                          ))}
                          <th className="py-2 text-right font-normal">Total</th>
                          <th className="py-2 text-right font-normal">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdownPeriods.length === 0 ? (
                          <tr>
                            <td
                              colSpan={activeProviders.length + 3}
                              className="py-6 text-center text-muted-foreground"
                            >
                              No activity in this window.
                            </td>
                          </tr>
                        ) : (
                          breakdownPeriods.map((period) => (
                            <tr
                              key={"hourStart" in period ? period.hourStart : period.day}
                              className="border-b border-border/50 transition-colors hover:bg-muted/50"
                            >
                              <td className="py-2 text-foreground">
                                {"hourStart" in period
                                  ? formatHourShort(period.hourStart, window.timeZone)
                                  : formatDayShort(period.day)}
                              </td>
                              {activeProviders.map((provider) => (
                                <td
                                  key={provider}
                                  className="py-2 text-right text-muted-foreground tabular-nums"
                                >
                                  {formatUsd(period.byProvider.get(provider)?.costUsd ?? 0)}
                                </td>
                              ))}
                              <td className="py-2 text-right text-foreground tabular-nums">
                                {formatUsd(period.costUsd)}
                              </td>
                              <td className="py-2 text-right text-muted-foreground tabular-nums">
                                {formatTokens(period.totalTokens)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  )}
                </section>
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function SubscriptionUsagePanel({
  environments,
  statuses,
  isPending,
  history,
  historyDay,
  isHistoryPending,
  hasHistoryResponse,
  isHistoryIncomplete,
}: {
  readonly environments: readonly SubscriptionEnvironmentUsageStatus[];
  readonly statuses: readonly SubscriptionUsageStatus[];
  readonly isPending: boolean;
  readonly history: MergedUsage;
  readonly historyDay: string;
  readonly isHistoryPending: boolean;
  readonly hasHistoryResponse: boolean;
  readonly isHistoryIncomplete: boolean;
}) {
  const [revealedEmails, setRevealedEmails] = useState<ReadonlySet<string>>(() => new Set());
  const toggleEmail = (email: string) => {
    setRevealedEmails((current) => {
      const next = new Set(current);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  };

  if (isPending) {
    return (
      <section className="grid gap-4 md:grid-cols-2">
        {["account", "limits"].map((key) => (
          <div key={key} className="flex min-h-48 flex-col gap-4 border border-border p-5">
            <div className="h-5 w-36 rounded-sm bg-muted" />
            <div className="h-3 w-52 rounded-sm bg-muted" />
            <div className="mt-4 h-2 w-full rounded-full bg-muted" />
            <div className="h-3 w-40 rounded-sm bg-muted" />
          </div>
        ))}
      </section>
    );
  }

  if (statuses.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <SubscriptionCoverageNotice environments={environments} />
        <section className="border border-border px-5 py-8 text-center">
          <h2 className="text-sm font-medium text-foreground">No supported provider configured</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Enable Codex, Claude, or Grok and sign in to see subscription limits here.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <SubscriptionCoverageNotice environments={environments} />
      <section className="grid gap-4 md:grid-cols-2">
        {statuses.map((status) => {
          const { provider } = status;
          const expectedUsageProvider = expectedSubscriptionProvider(provider) ?? "chatgpt";
          const usage =
            provider.subscriptionUsage?.provider === expectedUsageProvider
              ? provider.subscriptionUsage
              : null;
          const providerName = subscriptionProviderName(expectedUsageProvider);
          const email = provider.auth.email?.trim();
          const emailKey = email?.toLocaleLowerCase();
          const emailIsConcealed = emailKey ? !revealedEmails.has(emailKey) : false;
          const historyProvider: UsageProviderKind =
            expectedUsageProvider === "grok"
              ? "grok"
              : expectedUsageProvider === "claude"
                ? "claude"
                : "codex";
          const today = history.daily
            .find((day) => day.day === historyDay)
            ?.byProvider.get(historyProvider);
          const last30Days = history.providers.find(
            (totals) => totals.provider === historyProvider,
          );
          const historyValue = (value: string) =>
            isHistoryPending || !hasHistoryResponse ? "—" : value;
          return (
            <article
              key={status.accountKey}
              className="flex min-w-0 flex-col gap-5 border border-border p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <ProviderMark provider={historyProvider} className="size-5" />
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-medium text-foreground">{providerName}</h2>
                    <p className="truncate text-xs text-muted-foreground">
                      {usage
                        ? subscriptionPlanLabel(usage.provider, usage.plan, provider.auth.label)
                        : (provider.auth.label ?? provider.displayName ?? provider.instanceId)}
                    </p>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {new Date(provider.checkedAt).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </div>

              {usage && usage.windows.length > 0 ? (
                <div className="flex flex-col gap-5">
                  {usage.windows.map((window) => {
                    const remainingPercent = Math.max(0, 100 - window.usedPercent);
                    return (
                      <div
                        key={`${window.kind}:${window.scope?.type ?? "overall"}:${window.scope?.id ?? "all"}`}
                        className="flex flex-col gap-2"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-sm text-foreground">
                            {subscriptionWindowLabel(window)}
                          </span>
                          <span className="text-sm font-medium text-foreground tabular-nums">
                            {window.usedPercent.toLocaleString(undefined, {
                              maximumFractionDigits: 1,
                            })}
                            % used
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-muted">
                          <div
                            role="progressbar"
                            aria-label={subscriptionWindowLabel(window)}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={window.usedPercent}
                            className={cn(
                              "h-full rounded-full",
                              window.usedPercent >= 90 ? "bg-destructive" : "bg-foreground",
                            )}
                            style={{ width: `${window.usedPercent}%` }}
                          />
                        </div>
                        <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>
                            {remainingPercent.toLocaleString(undefined, {
                              maximumFractionDigits: 1,
                            })}
                            % remaining
                          </span>
                          <span>{subscriptionResetLabel(window.resetsAt)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="border-t border-border pt-4 text-sm text-muted-foreground">
                  {subscriptionUnavailableMessage(provider)}
                </div>
              )}

              <div className="border-t border-border pt-4">
                <div className="mb-3 flex items-baseline justify-between gap-3">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Token history
                  </h3>
                  <span className="text-[11px] text-muted-foreground">API-equivalent</span>
                </div>
                <div className="grid grid-cols-2 gap-x-5 gap-y-4">
                  <SubscriptionHistoryMetric
                    label="Cost today"
                    value={historyValue(formatUsd(today?.costUsd ?? 0))}
                  />
                  <SubscriptionHistoryMetric
                    label="Cost · 30 days"
                    value={historyValue(formatUsd(last30Days?.costUsd ?? 0))}
                  />
                  <SubscriptionHistoryMetric
                    label="Tokens today"
                    value={historyValue(formatTokens(today?.totalTokens ?? 0))}
                  />
                  <SubscriptionHistoryMetric
                    label="Tokens · 30 days"
                    value={historyValue(formatTokens(last30Days?.totalTokens ?? 0))}
                  />
                </div>
                <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
                  {isHistoryPending
                    ? "Scanning local transcript history…"
                    : !hasHistoryResponse
                      ? "Token history is unavailable from connected environments."
                      : isHistoryIncomplete
                        ? "Some connected environments could not report current history; totals may be incomplete."
                        : last30Days && last30Days.unpricedRecords > 0
                          ? `${formatCount(last30Days.unpricedRecords)} records use unknown model pricing and are excluded from cost.`
                          : last30Days && last30Days.cacheSavingsUsd > 0
                            ? `Includes cached-token pricing, saving ${formatUsd(last30Days.cacheSavingsUsd)} over full input rates.`
                            : "Uses provider-reported cost or cache-aware model pricing when available."}
                </p>
              </div>

              {email && emailKey ? (
                <div className="mt-auto border-t border-border pt-3 text-xs text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={
                            emailIsConcealed ? "Reveal account email" : "Hide account email"
                          }
                          aria-pressed={!emailIsConcealed}
                          onClick={() => toggleEmail(emailKey)}
                          className={cn(
                            "cursor-pointer select-none rounded-sm outline-none transition-[filter] focus-visible:ring-2 focus-visible:ring-ring",
                            emailIsConcealed && "blur-[2px]",
                          )}
                        />
                      }
                    >
                      {emailIsConcealed ? scrambleSubscriptionEmail(email) : email}
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      {emailIsConcealed ? "Reveal account email" : "Hide account email"}
                    </TooltipPopup>
                  </Tooltip>
                </div>
              ) : null}
            </article>
          );
        })}
      </section>

      <p className="text-xs text-muted-foreground">
        Limits come directly from the signed-in provider account and include usage outside T3 Code.
        Token history is combined by provider across connected environments and may not match one
        account's limits.
      </p>
    </div>
  );
}

function SubscriptionCoverageNotice({
  environments,
}: {
  readonly environments: readonly SubscriptionEnvironmentUsageStatus[];
}) {
  const pending = environments.filter((environment) => environment.isPending);
  const failed = environments.filter((environment) => environment.error !== null);
  if (pending.length === 0 && failed.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 border border-border px-3 py-2 text-xs text-muted-foreground">
      {pending.map((environment) => (
        <span key={environment.environmentId}>
          {environment.label} is still reporting subscription limits.
        </span>
      ))}
      {failed.map((environment) => (
        <span key={environment.environmentId}>
          {environment.label} could not report subscription limits.
        </span>
      ))}
      <span>Subscription coverage may be incomplete.</span>
    </div>
  );
}

function SubscriptionHistoryMetric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-base font-medium tabular-nums text-foreground">{value}</p>
    </div>
  );
}

/** Brand mark for the harness a row belongs to. */
function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const Mark = PROVIDER_PRESENTATION[provider].mark;
  return <Mark className={cn("shrink-0", className)} aria-hidden />;
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-medium text-foreground tabular-nums">{value}</span>
    </div>
  );
}

/**
 * Says plainly when the totals are incomplete: an environment that failed, or
 * one whose transcripts another environment already reported. Environments
 * that are still answering never reach this notice; the page shows the
 * loading skeleton until every one is terminal.
 */
function UsageCoverageNotice({
  environments,
  duplicateSources,
  staleEnvironments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly staleEnvironments: readonly string[];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  const stale = environments.filter((environment) =>
    staleEnvironments.includes(environment.environmentId),
  );
  if (failed.length === 0 && stale.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border border-border px-3 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.label}>{environment.label} could not report usage.</span>
      ))}
      {stale.map((environment) => (
        <span key={environment.label}>
          {environment.label} runs an older server version and is excluded from totals.
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          Counted once across environments sharing a transcript directory:{" "}
          {duplicateSources.join(", ")}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Per-device progress while the page waits for every environment to answer.
 * Only rendered with two or more devices; a lone device has nothing to
 * enumerate.
 */
function UsageDeviceStrip({
  environments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
}) {
  const scanning = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  );
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border border-border px-3 py-2 text-xs">
      {environments.map((environment) => {
        if (environment.summary !== null) {
          return (
            <span
              key={environment.environmentId}
              className="flex items-center gap-1 text-foreground"
            >
              <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-300/90" aria-hidden />
              {environment.label}
            </span>
          );
        }
        if (environment.error !== null) {
          return (
            <span
              key={environment.environmentId}
              className="flex items-center gap-1 text-destructive"
            >
              <XIcon className="size-3" aria-hidden />
              {environment.label}
            </span>
          );
        }
        return (
          <span
            key={environment.environmentId}
            className="animate-status-pulse text-muted-foreground"
          >
            {environment.label}…
          </span>
        );
      })}
      <span className="ms-auto text-muted-foreground">
        {scanning.length === 1
          ? "1 device still scanning"
          : `${scanning.length} devices still scanning`}
      </span>
    </div>
  );
}

/**
 * Static stand-in with the loaded page's shape. No shimmer; blocks fill in
 * exactly once when the last device answers.
 */
function UsageSkeleton() {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <div className="h-10 w-36 rounded-sm bg-muted" />
            <div className="h-4 w-32 rounded-sm bg-muted" />
          </div>
          {PROVIDER_ORDER.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: PROVIDER_PRESENTATION[provider].color }}
                  />
                  <ProviderMark provider={provider} className="size-4" />
                  <div className="h-3.5 w-20 rounded-sm bg-muted" />
                </span>
                <div className="h-3.5 w-14 rounded-sm bg-muted" />
              </div>
              <div className="h-4 w-36 rounded-sm bg-muted" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <div className="h-5 w-24 rounded-sm bg-muted" />
          <div className="flex flex-col gap-1">
            <div className="ml-16 h-56 rounded-sm bg-muted/35" />
            <div className="ml-16 h-3 rounded-sm bg-muted/35" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Totals</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
          {["Processed tokens", "Cached input", "Uncached input", "Output", "Cache savings"].map(
            (label) => (
              <div key={label} className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">{label}</span>
                <div className="my-0.5 h-4 w-16 rounded-sm bg-muted" />
              </div>
            ),
          )}
        </div>
      </section>
    </>
  );
}

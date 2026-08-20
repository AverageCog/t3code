import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  expectedSubscriptionProvider,
  scrambleSubscriptionEmail,
  type SubscriptionEnvironmentUsageStatus,
  type SubscriptionUsageStatus,
} from "@t3tools/client-runtime/state/subscription-usage";
import type {
  ServerProvider,
  SubscriptionUsageProvider,
  SubscriptionUsageWindow,
} from "@t3tools/contracts";
import type { DailyTotals, MergedUsage } from "@t3tools/shared/usageMerge";
import {
  DEFAULT_USAGE_PAGE_SELECTION,
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
  type UsageHistoryDays,
  type UsagePageSelection,
} from "@t3tools/shared/usageFormat";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useSubscriptionUsage, useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { SettingsSection } from "../settings/components/SettingsSection";
import { UsageDailyChart } from "./UsageDailyChart";
import type { UsageChartMetric } from "./usageChartData";
import { PROVIDER_LABEL, useProviderColors } from "./usageProviders";

const WINDOW_OPTIONS = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

const VIEW_OPTIONS: readonly {
  readonly value: UsagePageSelection;
  readonly label: string;
}[] = [
  ...WINDOW_OPTIONS.map((option) => ({ value: option.days, label: option.label })),
  {
    value: "subscriptions",
    label: "Subscriptions",
  },
];

const CHART_HEIGHT = 180;

export function UsageRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const usageSelection = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.usagePageSelection ?? DEFAULT_USAGE_PAGE_SELECTION)
    : DEFAULT_USAGE_PAGE_SELECTION;
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

  const days = useMemo(
    () => enumerateDays(window.sinceDay, window.untilDay),
    [window.sinceDay, window.untilDay],
  );
  const chartDays = useMemo(
    () =>
      isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
        ? enumerateHourStarts(window.sinceTime, window.untilTime)
        : days,
    [days, isPast24Hours, window.sinceTime, window.untilTime],
  );
  const chartTotals = useMemo(
    (): readonly DailyTotals[] =>
      isPast24Hours
        ? merged.hourly.map((hour) => ({
            day: hour.hourStart,
            costUsd: hour.costUsd,
            totalTokens: hour.totalTokens,
            byProvider: hour.byProvider,
          }))
        : merged.daily,
    [isPast24Hours, merged.daily, merged.hourly],
  );

  // The pull spinner tracks re-scans of environments that have answered
  // before. The initial scan renders its own placeholder, and an unreachable
  // environment stays pending forever — neither may pin the spinner on.
  const historyRefreshing = environments.some((entry) => entry.isPending && entry.summary !== null);
  const selectWindow = (days: UsageHistoryDays) => {
    savePreferences({ usagePageSelection: days });
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
  const refreshView = () => {
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

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Usage" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={
              activeView === "subscriptions" ? subscriptions.isRefreshing : historyRefreshing
            }
            onRefresh={refreshView}
          />
        }
      >
        <SegmentedControl
          options={VIEW_OPTIONS}
          selected={usageSelection}
          onSelect={(selection) => {
            if (selection === "subscriptions") {
              savePreferences({ usagePageSelection: "subscriptions" });
            } else {
              selectWindow(selection);
            }
          }}
        />

        {activeView === "subscriptions" ? (
          <SubscriptionUsageContent
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
              subscriptionHistory.environments.some((environment) => environment.error !== null) ||
              subscriptionHistory.merged.staleEnvironments.length > 0
            }
          />
        ) : (
          <>
            <UsageCoverageNotice
              environments={environments}
              merged={merged}
              isPartial={isPartial}
            />
            {isPending ? (
              <Text className="py-16 text-center text-base text-foreground-muted">
                Scanning provider transcripts…
              </Text>
            ) : environments.length === 0 ? (
              <Text className="py-16 text-center text-base text-foreground-muted">
                Connect an environment to see usage.
              </Text>
            ) : (
              <>
                <ChartCard
                  merged={merged}
                  days={chartDays}
                  daily={chartTotals}
                  metric={metric}
                  onMetricChange={setMetric}
                  sinceDay={window.sinceDay}
                  untilDay={window.untilDay}
                  isPast24Hours={isPast24Hours}
                  timeZone={window.timeZone}
                />
                <ProviderSection merged={merged} metric={metric} />
                <TotalsSection merged={merged} isPast24Hours={isPast24Hours} />
                <ModelsSection merged={merged} />
              </>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function subscriptionPlanLabel(
  provider: SubscriptionUsageProvider,
  plan: string | null,
  fallback: string | undefined,
): string {
  if (fallback) return fallback.replace(/ Subscription$/, "");
  if (!plan || plan === "unknown")
    return `${provider === "grok" ? "Grok" : provider === "claude" ? "Claude" : "ChatGPT"} subscription`;
  const normalizedPlan = plan.replaceAll("_", " ");
  if (provider === "grok") return normalizedPlan;
  if (provider === "claude") {
    return normalizedPlan.toLowerCase().startsWith("claude")
      ? normalizedPlan
      : `Claude ${normalizedPlan}`;
  }
  return `ChatGPT ${normalizedPlan}`;
}

function subscriptionWindowLabel(window: SubscriptionUsageWindow): string {
  let label: string;
  if (window.kind === "weekly") label = "Weekly limit";
  else if (window.kind === "monthly") label = "Monthly limit";
  else if (window.windowDurationMinutes === 300) label = "5-hour limit";
  else if (window.windowDurationMinutes === 10_080) label = "Weekly limit";
  else if (window.windowDurationMinutes !== null) {
    if (window.windowDurationMinutes % 1_440 === 0) {
      label = `${window.windowDurationMinutes / 1_440}-day limit`;
    } else if (window.windowDurationMinutes % 60 === 0) {
      label = `${window.windowDurationMinutes / 60}-hour limit`;
    } else label = window.kind === "primary" ? "5-hour limit" : "Weekly limit";
  } else label = window.kind === "primary" ? "5-hour limit" : "Weekly limit";
  return window.scope ? `${window.scope.label} ${label.toLocaleLowerCase()}` : label;
}

function subscriptionUnavailableMessage(provider: ServerProvider): string {
  if (provider.driver === "grok") {
    return "This Grok account or CLI version did not report subscription limits. Sign in to Grok, update the CLI, and refresh to try again.";
  }
  if (provider.driver === "claudeAgent") {
    if (provider.auth.status !== "authenticated") {
      return "Sign in to Claude Code with a Claude subscription to read subscription limits.";
    }
    if (
      provider.auth.type === "apiKey" ||
      provider.auth.type === "bedrock" ||
      provider.auth.type === "vertex" ||
      provider.auth.type === "foundry" ||
      provider.auth.type === "anthropicAws" ||
      provider.auth.type === "mantle" ||
      provider.auth.type === "gateway"
    ) {
      return "This Claude instance uses API billing, so it has no Claude subscription limits.";
    }
    return "This Claude account or Claude Code version did not report subscription limits. Update Claude Code and refresh to try again.";
  }
  if (provider.auth.status !== "authenticated") {
    return "Sign in to Codex with ChatGPT to read subscription limits.";
  }
  if (provider.auth.type !== "chatgpt") {
    return "This Codex instance uses API billing, so it has no ChatGPT subscription limits.";
  }
  return "This Codex version did not report subscription limits. Update Codex and refresh to try again.";
}

function subscriptionResetLabel(resetsAt: string | null): string {
  if (resetsAt === null) return "Reset time unavailable";
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) return "Reset time unavailable";
  return `Resets ${reset.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function SubscriptionUsageContent(props: {
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

  if (props.isPending) {
    return (
      <Text className="py-16 text-center text-base text-foreground-muted">
        Reading subscription limits…
      </Text>
    );
  }

  if (props.statuses.length === 0) {
    return (
      <View className="gap-4">
        <SubscriptionCoverageNotice environments={props.environments} />
        <View className="gap-1 rounded-[24px] border-continuous bg-card p-5">
          <Text className="text-center text-base font-t3-medium text-foreground">
            No supported provider configured
          </Text>
          <Text className="text-center text-sm text-foreground-muted">
            Enable Codex, Claude, or Grok and sign in to see subscription limits here.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="gap-4">
      <SubscriptionCoverageNotice environments={props.environments} />
      {props.statuses.map((status) => {
        const { provider } = status;
        const expectedUsageProvider = expectedSubscriptionProvider(provider) ?? "chatgpt";
        const usage =
          provider.subscriptionUsage?.provider === expectedUsageProvider
            ? provider.subscriptionUsage
            : null;
        const providerName =
          expectedUsageProvider === "grok"
            ? "Grok"
            : expectedUsageProvider === "claude"
              ? "Claude"
              : "ChatGPT";
        const email = provider.auth.email?.trim();
        const emailKey = email?.toLocaleLowerCase();
        const emailIsConcealed = emailKey ? !revealedEmails.has(emailKey) : false;
        const historyProvider =
          expectedUsageProvider === "grok"
            ? "grok"
            : expectedUsageProvider === "claude"
              ? "claude"
              : "codex";
        const today = props.history.daily
          .find((day) => day.day === props.historyDay)
          ?.byProvider.get(historyProvider);
        const last30Days = props.history.providers.find(
          (totals) => totals.provider === historyProvider,
        );
        const historyValue = (value: string) =>
          props.isHistoryPending || !props.hasHistoryResponse ? "—" : value;
        return (
          <View
            key={`${provider.driver}:${provider.instanceId}:${provider.auth.email ?? status.sourceLabels.join(",")}`}
            className="gap-5 rounded-[24px] border-continuous bg-card p-5"
          >
            <View className="flex-row items-start justify-between gap-3">
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-lg font-t3-medium text-foreground">{providerName}</Text>
                <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                  {usage
                    ? subscriptionPlanLabel(usage.provider, usage.plan, provider.auth.label)
                    : (provider.auth.label ?? provider.displayName ?? provider.instanceId)}
                </Text>
              </View>
              <Text className="text-xs tabular-nums text-foreground-tertiary">
                {new Date(provider.checkedAt).toLocaleTimeString(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </Text>
            </View>

            {usage && usage.windows.length > 0 ? (
              <View className="gap-5">
                {usage.windows.map((window) => {
                  const remainingPercent = Math.max(0, 100 - window.usedPercent);
                  return (
                    <View
                      key={`${window.kind}:${window.scope?.type ?? "overall"}:${window.scope?.id ?? "all"}`}
                      className="gap-2"
                    >
                      <View className="flex-row items-baseline justify-between gap-3">
                        <Text className="text-base text-foreground">
                          {subscriptionWindowLabel(window)}
                        </Text>
                        <Text className="text-base font-t3-medium tabular-nums text-foreground">
                          {window.usedPercent.toLocaleString(undefined, {
                            maximumFractionDigits: 1,
                          })}
                          % used
                        </Text>
                      </View>
                      <View className="h-2 overflow-hidden rounded-full bg-subtle">
                        <View
                          accessibilityRole="progressbar"
                          accessibilityLabel={subscriptionWindowLabel(window)}
                          accessibilityValue={{
                            min: 0,
                            max: 100,
                            now: window.usedPercent,
                          }}
                          className={
                            window.usedPercent >= 90
                              ? "h-full rounded-full bg-danger-foreground"
                              : "h-full rounded-full bg-foreground"
                          }
                          style={{ width: `${window.usedPercent}%` }}
                        />
                      </View>
                      <View className="flex-row flex-wrap justify-between gap-x-3 gap-y-1">
                        <Text className="text-xs text-foreground-muted">
                          {remainingPercent.toLocaleString(undefined, {
                            maximumFractionDigits: 1,
                          })}
                          % remaining
                        </Text>
                        <Text className="text-xs text-foreground-muted">
                          {subscriptionResetLabel(window.resetsAt)}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : (
              <Text className="border-t border-border-subtle pt-4 text-sm text-foreground-muted">
                {subscriptionUnavailableMessage(provider)}
              </Text>
            )}

            <View className="gap-3 border-t border-border-subtle pt-4">
              <View className="flex-row items-baseline justify-between gap-3">
                <Text className="text-xs font-t3-medium uppercase tracking-wide text-foreground-muted">
                  Token history
                </Text>
                <Text className="text-xs text-foreground-tertiary">API-equivalent</Text>
              </View>
              <View className="flex-row gap-5">
                <SubscriptionHistoryMetric
                  label="Cost today"
                  value={historyValue(formatUsd(today?.costUsd ?? 0))}
                />
                <SubscriptionHistoryMetric
                  label="Cost · 30 days"
                  value={historyValue(formatUsd(last30Days?.costUsd ?? 0))}
                />
              </View>
              <View className="flex-row gap-5">
                <SubscriptionHistoryMetric
                  label="Tokens today"
                  value={historyValue(formatTokens(today?.totalTokens ?? 0))}
                />
                <SubscriptionHistoryMetric
                  label="Tokens · 30 days"
                  value={historyValue(formatTokens(last30Days?.totalTokens ?? 0))}
                />
              </View>
              <Text className="text-xs leading-4 text-foreground-tertiary">
                {props.isHistoryPending
                  ? "Scanning local transcript history…"
                  : !props.hasHistoryResponse
                    ? "Token history is unavailable from connected environments."
                    : props.isHistoryIncomplete
                      ? "Some connected environments could not report current history; totals may be incomplete."
                      : last30Days && last30Days.unpricedRecords > 0
                        ? `${formatCount(last30Days.unpricedRecords)} records use unknown model pricing and are excluded from cost.`
                        : last30Days && last30Days.cacheSavingsUsd > 0
                          ? `Includes cached-token pricing, saving ${formatUsd(last30Days.cacheSavingsUsd)} over full input rates.`
                          : "Uses provider-reported cost or cache-aware model pricing when available."}
              </Text>
            </View>

            {email && emailKey ? (
              <View className="flex-row border-t border-border-subtle pt-3">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    emailIsConcealed ? "Reveal account email" : "Hide account email"
                  }
                  accessibilityState={{ selected: !emailIsConcealed }}
                  onPress={() => toggleEmail(emailKey)}
                >
                  <Text
                    className="text-xs text-foreground-tertiary"
                    style={emailIsConcealed ? { filter: [{ blur: 2 }] } : undefined}
                  >
                    {emailIsConcealed ? scrambleSubscriptionEmail(email) : email}
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        );
      })}

      <Text className="px-1 text-xs text-foreground-tertiary">
        Limits come directly from the signed-in provider account and include usage outside T3 Code.
        Token history is combined by provider across connected environments and may not match one
        account's limits.
      </Text>
    </View>
  );
}

function SubscriptionCoverageNotice(props: {
  readonly environments: readonly SubscriptionEnvironmentUsageStatus[];
}) {
  const pending = props.environments.filter((environment) => environment.isPending);
  const failed = props.environments.filter((environment) => environment.error !== null);
  if (pending.length === 0 && failed.length === 0) return null;

  return (
    <View className="gap-1 rounded-[16px] border-continuous bg-card px-4 py-3">
      {pending.map((environment) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {environment.label} is still reporting subscription limits.
        </Text>
      ))}
      {failed.map((environment) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {environment.label} could not report subscription limits.
        </Text>
      ))}
      <Text className="text-sm text-foreground-muted">
        Subscription coverage may be incomplete.
      </Text>
    </View>
  );
}

function SubscriptionHistoryMetric(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="min-w-0 flex-1">
      <Text className="text-xs text-foreground-muted">{props.label}</Text>
      <Text
        className="mt-1 text-base font-t3-medium tabular-nums text-foreground"
        numberOfLines={1}
      >
        {props.value}
      </Text>
    </View>
  );
}

function SegmentedControl<Value extends number | string>(props: {
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
}) {
  return (
    <View className="flex-row overflow-hidden rounded-full border-continuous bg-card">
      {props.options.map((option) => {
        const active = option.value === props.selected;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => props.onSelect(option.value)}
            className={
              active
                ? "flex-1 items-center rounded-full bg-subtle-strong py-2"
                : "flex-1 items-center py-2"
            }
          >
            <Text
              adjustsFontSizeToFit
              minimumFontScale={0.75}
              numberOfLines={1}
              className={
                active ? "text-xs font-t3-medium text-foreground" : "text-xs text-foreground-muted"
              }
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Headline figure, the animated daily chart, and its legend, in one card. */
function ChartCard(props: {
  readonly merged: MergedUsage;
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly metric: UsageChartMetric;
  readonly onMetricChange: (metric: UsageChartMetric) => void;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly isPast24Hours: boolean;
  readonly timeZone: string;
}) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  const hasActivity = props.daily.some((period) => period.totalTokens > 0);

  return (
    <View className="gap-4 rounded-[24px] border-continuous bg-card p-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-sm text-foreground-muted">
            {metric === "cost" ? "Raw token cost" : "Processed tokens"}
          </Text>
          <Text className="text-4xl font-t3-bold tabular-nums text-foreground">
            {metric === "cost" ? `${formatUsd(merged.costUsd)}*` : formatTokens(merged.totalTokens)}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {metric === "cost"
              ? "* if billed at full API rate"
              : `Across ${formatCount(merged.sessions)} sessions`}
          </Text>
        </View>
        <MetricToggle metric={metric} onChange={props.onMetricChange} />
      </View>

      {hasActivity ? (
        <UsageDailyChart
          days={props.days}
          daily={props.daily}
          metric={metric}
          height={CHART_HEIGHT}
        />
      ) : (
        <View style={{ height: CHART_HEIGHT }} className="items-center justify-center">
          <Text className="text-base text-foreground-muted">No activity in this window.</Text>
        </View>
      )}

      <View className="flex-row items-center justify-between">
        <Text className="text-xs text-foreground-tertiary">
          {props.isPast24Hours
            ? formatHourShort(props.days[0] ?? "", props.timeZone)
            : formatDayShort(props.sinceDay)}
        </Text>
        <View className="flex-row items-center gap-4">
          {merged.providers.map((provider) => (
            <View key={provider.provider} className="flex-row items-center gap-1.5">
              <View
                className="size-2 rounded-full"
                style={{ backgroundColor: colors[provider.provider] }}
              />
              <Text className="text-xs text-foreground-muted">
                {PROVIDER_LABEL[provider.provider]}
              </Text>
            </View>
          ))}
        </View>
        <Text className="text-xs text-foreground-tertiary">
          {props.isPast24Hours
            ? formatHourShort(props.days[props.days.length - 1] ?? "", props.timeZone)
            : formatDayShort(props.untilDay)}
        </Text>
      </View>
    </View>
  );
}

function MetricToggle(props: {
  readonly metric: UsageChartMetric;
  readonly onChange: (metric: UsageChartMetric) => void;
}) {
  return (
    <View className="flex-row overflow-hidden rounded-full bg-subtle">
      {(["cost", "tokens"] as const).map((option) => {
        const active = option === props.metric;
        return (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => props.onChange(option)}
            className={active ? "rounded-full bg-subtle-strong px-3 py-1.5" : "px-3 py-1.5"}
          >
            <Text
              className={
                active
                  ? "text-xs font-t3-medium uppercase text-foreground"
                  : "text-xs uppercase text-foreground-muted"
              }
            >
              {option}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ProviderSection(props: {
  readonly merged: MergedUsage;
  readonly metric: UsageChartMetric;
}) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  if (merged.providers.length === 0) return null;

  // Ranked by whatever the toggle is showing, so the rows always descend.
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023 method.
  const ordered = [...merged.providers].sort((a, b) =>
    metric === "cost" ? b.costUsd - a.costUsd : b.totalTokens - a.totalTokens,
  );

  return (
    <SettingsSection title="Providers" card>
      {ordered.map((provider, index) => {
        const share = metric === "cost" ? provider.costShare : provider.tokenShare;
        return (
          <View
            key={provider.provider}
            className={index === 0 ? "gap-2 p-4" : "gap-2 border-t border-border-subtle p-4"}
          >
            <View className="flex-row items-baseline justify-between gap-3">
              <View className="flex-row items-center gap-2">
                <View
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: colors[provider.provider] }}
                />
                <Text className="text-lg text-foreground">{PROVIDER_LABEL[provider.provider]}</Text>
              </View>
              <Text className="text-lg tabular-nums text-foreground">
                {metric === "cost"
                  ? formatUsd(provider.costUsd)
                  : formatTokens(provider.totalTokens)}
              </Text>
            </View>
            <View className="h-1 flex-row overflow-hidden rounded-full bg-subtle">
              <View
                className="h-full rounded-full"
                style={{ flex: share, backgroundColor: colors[provider.provider] }}
              />
              <View style={{ flex: 1 - share }} />
            </View>
            <Text className="text-sm text-foreground-muted">
              {metric === "cost"
                ? `${formatPercent(share)} of cost · ${formatTokens(provider.totalTokens)} tokens`
                : `${formatPercent(share)} of tokens · ${formatUsd(provider.costUsd)}`}
            </Text>
          </View>
        );
      })}
    </SettingsSection>
  );
}

function TotalsSection(props: { readonly merged: MergedUsage; readonly isPast24Hours: boolean }) {
  const { merged } = props;
  const activePeriods = (props.isPast24Hours ? merged.hourly : merged.daily).filter(
    (period) => period.totalTokens > 0,
  ).length;
  const periodAverage = activePeriods === 0 ? 0 : merged.totalTokens / activePeriods;
  const observedInput = merged.uncachedInputTokens + merged.cachedInputTokens;
  const cachedShare = observedInput === 0 ? 0 : merged.cachedInputTokens / observedInput;

  return (
    <SettingsSection title="Totals" card>
      <View className="flex-row flex-wrap">
        <MetricCell
          label="Processed tokens"
          value={formatTokens(merged.totalTokens)}
          detail={`${formatTokens(periodAverage)} per active ${props.isPast24Hours ? "hour" : "day"}`}
        />
        <MetricCell
          label="Cache savings"
          value={formatUsd(merged.costQuality.cacheSavingsUsd)}
          detail={
            merged.costUsd > 0
              ? `${(merged.costQuality.cacheSavingsUsd / merged.costUsd).toFixed(1)}x the raw cost`
              : "vs full input rates"
          }
        />
        <MetricCell
          label="Cached input"
          value={formatTokens(merged.cachedInputTokens)}
          detail={`${formatPercent(cachedShare)} of observed input`}
        />
        <MetricCell
          label="Uncached input"
          value={formatTokens(merged.uncachedInputTokens)}
          detail={`${formatTokens(merged.cacheCreationTokens)} cache writes`}
        />
        <MetricCell
          label="Output"
          value={formatTokens(merged.outputTokens)}
          detail={`incl. ${formatTokens(merged.reasoningTokens)} reasoning`}
        />
        <MetricCell
          label="Unpriced"
          value={formatPercent(merged.costQuality.unpricedShare)}
          detail="of records, excluded from cost"
        />
      </View>
    </SettingsSection>
  );
}

function MetricCell(props: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <View className="w-1/2 gap-0.5 p-4">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text className="text-xl font-t3-medium tabular-nums text-foreground">{props.value}</Text>
      <Text className="text-xs text-foreground-tertiary">{props.detail}</Text>
    </View>
  );
}

function ModelsSection(props: { readonly merged: MergedUsage }) {
  const { merged } = props;
  const colors = useProviderColors();
  if (merged.models.length === 0) return null;

  return (
    <SettingsSection title="By model" card>
      {merged.models.map((model, index) => (
        <View
          key={`${model.provider}:${model.model}`}
          className={
            index === 0
              ? "flex-row items-center gap-3 p-4"
              : "flex-row items-center gap-3 border-t border-border-subtle p-4"
          }
        >
          <View
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: colors[model.provider] }}
          />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-base text-foreground" numberOfLines={1}>
              {model.model}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {formatPercent(model.costShare)} of cost · {formatTokens(model.totalTokens)} tokens
            </Text>
          </View>
          <Text className="text-base tabular-nums text-foreground">{formatUsd(model.costUsd)}</Text>
        </View>
      ))}
    </SettingsSection>
  );
}

/**
 * Says plainly when the totals are incomplete: an environment still answering,
 * one that failed, or one whose transcripts another environment already
 * reported.
 */
function UsageCoverageNotice(props: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly merged: MergedUsage;
  readonly isPartial: boolean;
}) {
  const failed = props.environments.filter((environment) => environment.error !== null);
  const stale = props.environments.filter((environment) =>
    props.merged.staleEnvironments.includes(environment.environmentId),
  );
  const duplicateSources = props.merged.duplicateSources;
  if (
    failed.length === 0 &&
    stale.length === 0 &&
    duplicateSources.length === 0 &&
    !props.isPartial
  ) {
    return null;
  }

  return (
    <View className="gap-1 rounded-[16px] border-continuous bg-card px-4 py-3">
      {props.isPartial ? (
        <Text className="text-sm text-foreground-muted">
          Some environments are still reporting. Totals are partial.
        </Text>
      ) : null}
      {failed.map((environment) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {environment.label} could not report usage.
        </Text>
      ))}
      {stale.map((environment) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {environment.label} runs an older server version and is excluded from totals.
        </Text>
      ))}
      {duplicateSources.length > 0 ? (
        <Text className="text-sm text-foreground-muted">
          Counted once across environments sharing a transcript directory:{" "}
          {duplicateSources.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}

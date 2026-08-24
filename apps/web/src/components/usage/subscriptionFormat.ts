import type {
  ServerProvider,
  SubscriptionUsageProvider,
  SubscriptionUsageWindow,
} from "@t3tools/contracts";

/**
 * Presentation strings shared by the usage page's Subscriptions tab and the
 * sidebar's subscription peek menu, so both surfaces describe limits alike.
 *
 * @module usage/subscriptionFormat
 */

export function subscriptionProviderName(provider: SubscriptionUsageProvider): string {
  return provider === "grok" ? "Grok" : provider === "claude" ? "Claude" : "ChatGPT";
}

export function subscriptionPlanLabel(
  provider: SubscriptionUsageProvider,
  plan: string | null,
  fallback: string | undefined,
): string {
  if (fallback) return fallback.replace(/ Subscription$/, "");
  if (!plan || plan === "unknown") return `${subscriptionProviderName(provider)} subscription`;
  const normalizedPlan = plan.replaceAll("_", " ");
  if (provider === "grok") return normalizedPlan;
  if (provider === "claude") {
    return normalizedPlan.toLowerCase().startsWith("claude")
      ? normalizedPlan
      : `Claude ${normalizedPlan}`;
  }
  return `ChatGPT ${normalizedPlan}`;
}

export function subscriptionWindowLabel(window: SubscriptionUsageWindow): string {
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

export function subscriptionUnavailableMessage(provider: ServerProvider): string {
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

export function subscriptionResetLabel(resetsAt: string | null): string {
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

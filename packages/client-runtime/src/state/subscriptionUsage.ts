import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";

export interface SubscriptionEnvironmentProviders {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly providers: readonly ServerProvider[] | null;
}

export interface SubscriptionEnvironmentUsageStatus extends SubscriptionEnvironmentProviders {
  readonly isPending: boolean;
  readonly error: string | null;
}

export interface SubscriptionUsageStatus {
  readonly provider: ServerProvider;
  readonly sourceLabels: readonly string[];
}

export interface SubscriptionUsageState {
  readonly environments: readonly SubscriptionEnvironmentUsageStatus[];
  readonly statuses: readonly SubscriptionUsageStatus[];
  /** True only while no environment has answered and at least one still can. */
  readonly isPending: boolean;
  /** True when loaded results are visible while another environment is still answering. */
  readonly isPartial: boolean;
}

/** Produces a stable visual scramble while preserving email punctuation and width. */
export function scrambleSubscriptionEmail(email: string): string {
  const characters = Array.from(email);
  const letterIndexes = characters.flatMap((character, index) =>
    /[a-z0-9]/i.test(character) ? [index] : [],
  );
  const shuffled = letterIndexes.map((index) => characters[index] ?? "");

  let seed = 2_166_136_261;
  for (const character of characters) {
    seed ^= character.codePointAt(0) ?? 0;
    seed = Math.imul(seed, 16_777_619) >>> 0;
  }
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    const swapIndex = seed % (index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex] ?? "", shuffled[index] ?? ""];
  }

  if (
    shuffled.length > 1 &&
    letterIndexes.every((index, offset) => characters[index] === shuffled[offset])
  ) {
    shuffled.push(shuffled.shift() ?? "");
  }
  for (const [offset, index] of letterIndexes.entries()) {
    characters[index] = shuffled[offset] ?? characters[index] ?? "";
  }
  return characters.join("");
}

export function expectedSubscriptionProvider(
  provider: ServerProvider,
): "chatgpt" | "claude" | "grok" | undefined {
  if (provider.driver === "codex") return "chatgpt";
  if (provider.driver === "claudeAgent") return "claude";
  if (provider.driver === "grok") return "grok";
  return undefined;
}

/**
 * Separates each environment's loading and failure state so an unavailable
 * remote never hides subscription data that another environment already sent.
 */
export function collectSubscriptionUsageState(
  environments: readonly SubscriptionEnvironmentProviders[],
): SubscriptionUsageState {
  const environmentStatuses = environments.map((environment) => {
    if (environment.connectionPhase === "connected") {
      return {
        ...environment,
        isPending: environment.providers === null,
        error: null,
      };
    }
    if (environment.connectionPhase === "connecting") {
      return { ...environment, isPending: true, error: null };
    }
    return {
      ...environment,
      isPending: false,
      error: "This environment could not report subscription limits.",
    };
  });
  const answeredCount = environmentStatuses.filter(
    (environment) => environment.providers !== null,
  ).length;
  const pendingCount = environmentStatuses.filter((environment) => environment.isPending).length;

  return {
    environments: environmentStatuses,
    statuses: collectSubscriptionUsageStatuses(environments),
    isPending: answeredCount === 0 && pendingCount > 0,
    isPartial: answeredCount > 0 && pendingCount > 0,
  };
}

/**
 * Collapses the same ChatGPT or Claude account reported by multiple
 * environments while preserving separate configured accounts and providers
 * without a stable account identity (currently Grok).
 */
export function collectSubscriptionUsageStatuses(
  environments: readonly SubscriptionEnvironmentProviders[],
): readonly SubscriptionUsageStatus[] {
  const byAccount = new Map<string, SubscriptionUsageStatus>();

  for (const environment of environments) {
    for (const provider of environment.providers ?? []) {
      const expectedProvider = expectedSubscriptionProvider(provider);
      if (!expectedProvider || !provider.enabled) continue;

      const email = provider.auth.email?.trim().toLocaleLowerCase();
      const accountKey =
        (expectedProvider === "chatgpt" || expectedProvider === "claude") && email
          ? `${expectedProvider}:${email}`
          : `${environment.environmentId}:${provider.driver}:${provider.instanceId}`;
      const existing = byAccount.get(accountKey);
      if (!existing) {
        byAccount.set(accountKey, { provider, sourceLabels: [environment.label] });
        continue;
      }

      const sourceLabels = [...new Set([...existing.sourceLabels, environment.label])];
      const existingHasUsage =
        existing.provider.subscriptionUsage?.provider ===
        expectedSubscriptionProvider(existing.provider);
      const candidateHasUsage = provider.subscriptionUsage?.provider === expectedProvider;
      const shouldReplace =
        (candidateHasUsage && !existingHasUsage) ||
        (candidateHasUsage === existingHasUsage &&
          provider.checkedAt > existing.provider.checkedAt);
      byAccount.set(accountKey, {
        provider: shouldReplace ? provider : existing.provider,
        sourceLabels,
      });
    }
  }

  return [...byAccount.values()].sort((a, b) => {
    const aSubscriptionProvider = expectedSubscriptionProvider(a.provider);
    const bSubscriptionProvider = expectedSubscriptionProvider(b.provider);
    const aHasUsage = a.provider.subscriptionUsage?.provider === aSubscriptionProvider;
    const bHasUsage = b.provider.subscriptionUsage?.provider === bSubscriptionProvider;
    if (aHasUsage !== bHasUsage) return aHasUsage ? -1 : 1;
    if (aSubscriptionProvider !== bSubscriptionProvider) {
      const providerOrder = { chatgpt: 0, claude: 1, grok: 2 } as const;
      return (
        providerOrder[aSubscriptionProvider ?? "grok"] -
        providerOrder[bSubscriptionProvider ?? "grok"]
      );
    }
    return (a.provider.displayName ?? a.provider.instanceId).localeCompare(
      b.provider.displayName ?? b.provider.instanceId,
    );
  });
}

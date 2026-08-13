import {
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectSubscriptionUsageStatuses,
  scrambleSubscriptionEmail,
} from "./subscriptionUsage.ts";

function provider(instanceId: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", type: "chatgpt", email: "dev@example.com" },
    checkedAt: "2026-04-10T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("collectSubscriptionUsageStatuses", () => {
  it("deduplicates the same ChatGPT account across environments", () => {
    const older = provider("codex-personal", {
      checkedAt: "2026-04-10T00:00:00.000Z",
      subscriptionUsage: { provider: "chatgpt", plan: "plus", windows: [] },
    });
    const newer = provider("codex-personal", {
      checkedAt: "2026-04-10T01:00:00.000Z",
      subscriptionUsage: {
        provider: "chatgpt",
        plan: "plus",
        windows: [
          {
            kind: "primary",
            usedPercent: 42,
            windowDurationMinutes: 300,
            resetsAt: null,
          },
        ],
      },
    });

    const result = collectSubscriptionUsageStatuses([
      { environmentId: "local" as EnvironmentId, label: "Mac", providers: [older] },
      { environmentId: "remote" as EnvironmentId, label: "Server", providers: [newer] },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.provider).toBe(newer);
    expect(result[0]?.sourceLabels).toEqual(["Mac", "Server"]);
  });

  it("keeps distinct ChatGPT accounts and Codex API-key instances separate", () => {
    const result = collectSubscriptionUsageStatuses([
      {
        environmentId: "local" as EnvironmentId,
        label: "Mac",
        providers: [
          provider("personal"),
          provider("work", {
            auth: { status: "authenticated", type: "chatgpt", email: "work@example.com" },
          }),
          provider("api", {
            auth: { status: "authenticated", type: "apiKey", label: "OpenAI API Key" },
          }),
        ],
      },
    ]);

    expect(result).toHaveLength(3);
  });

  it("includes Grok subscription usage as a distinct environment account", () => {
    const grok = provider("grok", {
      driver: ProviderDriverKind.make("grok"),
      auth: { status: "unknown" },
      subscriptionUsage: {
        provider: "grok",
        plan: "SuperGrok",
        windows: [
          {
            kind: "weekly",
            usedPercent: 18,
            windowDurationMinutes: 10_080,
            resetsAt: null,
          },
        ],
      },
    });

    const result = collectSubscriptionUsageStatuses([
      { environmentId: "local" as EnvironmentId, label: "Mac", providers: [grok] },
      { environmentId: "remote" as EnvironmentId, label: "Server", providers: [grok] },
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((status) => status.provider.subscriptionUsage?.provider)).toEqual([
      "grok",
      "grok",
    ]);
  });

  it("includes and deduplicates a Claude subscription account by email", () => {
    const claude = provider("claude-personal", {
      driver: ProviderDriverKind.make("claudeAgent"),
      auth: {
        status: "authenticated",
        type: "max",
        label: "Claude Max Subscription",
        email: "dev@example.com",
      },
      subscriptionUsage: {
        provider: "claude",
        plan: "max",
        windows: [
          {
            kind: "primary",
            usedPercent: 28,
            windowDurationMinutes: 300,
            resetsAt: null,
          },
        ],
      },
    });

    const result = collectSubscriptionUsageStatuses([
      { environmentId: "local" as EnvironmentId, label: "Mac", providers: [claude] },
      { environmentId: "remote" as EnvironmentId, label: "Server", providers: [claude] },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.provider.subscriptionUsage?.provider).toBe("claude");
    expect(result[0]?.sourceLabels).toEqual(["Mac", "Server"]);
  });
});

describe("scrambleSubscriptionEmail", () => {
  it("stably rearranges email characters while preserving its visual shape", () => {
    const email = "dev.account@example.com";
    const scrambled = scrambleSubscriptionEmail(email);

    expect(scrambled).toBe(scrambleSubscriptionEmail(email));
    expect(scrambled).not.toBe(email);
    expect(scrambled.length).toBe(email.length);
    expect(
      [...scrambled].flatMap((character, index) => (/[^a-z0-9]/i.test(character) ? [index] : [])),
    ).toEqual(
      [...email].flatMap((character, index) => (/[^a-z0-9]/i.test(character) ? [index] : [])),
    );
    expect([...scrambled].filter((character) => /[a-z0-9]/i.test(character)).sort()).toEqual(
      [...email].filter((character) => /[a-z0-9]/i.test(character)).sort(),
    );
  });
});

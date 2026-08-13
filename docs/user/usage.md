# Review usage

The Usage page combines Codex, Claude Code, and Grok activity from your connected environments. It
reads the providers' local session history and shows API-equivalent token cost, processed tokens,
cache savings, provider shares, and model breakdowns. Subscription billing is separate from the raw
token cost shown here.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

Use **Subscriptions** to see the current limits reported by ChatGPT, Claude, and Grok. The page
shows ChatGPT and Claude's rolling 5-hour and weekly windows and Grok's shared weekly pool when the
signed-in provider reports them, including how much remains, when each window resets, and the
subscription plan. Claude model- or feature-specific weekly limits are shown separately for OAuth
apps, Opus, and Sonnet when available. These figures come directly from the signed-in account and
include activity outside T3 Code. Codex and Claude instances using API billing do not have
subscription limits. Grok does not report a separate 5-hour subscription window. Account emails are
obscured by default; tap or click one to reveal it for the current visit to the Subscriptions tab.
If another connected environment is offline or still loading, available accounts stay visible and
the page identifies the missing environment as partial coverage.

Each subscription card also summarizes tokens and API-equivalent cost for today and the last 30
calendar days. Those totals come from local provider transcripts across connected environments, so
they may not match one subscription account when several accounts use the same provider. Cost uses
provider-reported totals when available and otherwise applies model pricing, including cached-token
rates. Records whose model cannot be priced still count toward tokens but are excluded from cost.

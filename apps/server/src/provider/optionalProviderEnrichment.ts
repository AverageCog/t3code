import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export const OPTIONAL_PROVIDER_ENRICHMENT_TIMEOUT_MS = 2_000;

/**
 * Bounds nonessential provider metadata without weakening the primary health
 * probe. Enrichment failures and timeouts are represented by missing data.
 */
export function optionalProviderEnrichment<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMs = OPTIONAL_PROVIDER_ENRICHMENT_TIMEOUT_MS,
): Effect.Effect<Option.Option<A>, never, R> {
  return effect.pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.orElseSucceed(() => Option.none<A>()),
  );
}

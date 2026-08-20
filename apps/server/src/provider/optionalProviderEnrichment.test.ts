import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { optionalProviderEnrichment } from "./optionalProviderEnrichment.ts";

it.effect("returns successful optional enrichment", () =>
  Effect.gen(function* () {
    const result = yield* optionalProviderEnrichment(Effect.succeed("limits"));
    assert.deepStrictEqual(result, Option.some("limits"));
  }),
);

it.effect("drops optional enrichment failures", () =>
  Effect.gen(function* () {
    const result = yield* optionalProviderEnrichment(Effect.fail("unavailable"));
    assert.deepStrictEqual(result, Option.none());
  }),
);

it.effect("stops waiting when optional enrichment stalls", () =>
  Effect.gen(function* () {
    const fiber = yield* optionalProviderEnrichment(Effect.never, 25).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(25));
    assert.deepStrictEqual(yield* Fiber.join(fiber), Option.none());
  }).pipe(Effect.provide(TestClock.layer())),
);

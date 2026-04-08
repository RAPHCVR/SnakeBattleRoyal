import { DEFAULT_GAME_CONFIG, type GameState, type SnakeState, type TickEvent } from "@snake-duel/shared";
import { describe, expect, it } from "vitest";
import {
  areControlledSnakesEquivalent,
  areGameStatesEquivalent,
  computeServerClockOffsetMs,
  computeTransition,
  createSessionSummary,
  estimateSnakeHeadCorrection,
  mergeControlledSnake,
  resolvePredictionLeadLimit,
  resolveRemoteInterpolationDelayMs,
  resolvePredictionStepDelayMs,
  resolveNextTickDelayMs,
  selectStableClockOffsetMs,
  toSessionSummary,
  toNetworkQuality,
  toNextTickAtMs,
  toProcessedInputSequences,
  toRngSeed,
  toSharedGameState,
  toTickEvent,
} from "./localGameStore.helpers.js";

describe("computeTransition", () => {
  it("prefers explicit tick event data for food and eliminations", () => {
    const previous = createGameState();
    const next = createGameState({
      snakes: [
        createSnake("player1", { score: 1 }),
        createSnake("player2", { alive: false }),
      ],
      food: { x: 8, y: 8 },
    });
    const tickEvent: TickEvent = {
      tick: 7,
      consumedFoodPosition: { x: 5, y: 5 },
      eliminatedSnakeIds: ["player2"],
      processedInputSequences: {
        player1: 0,
        player2: 0,
      },
    };

    const transition = computeTransition(previous, next, 7, tickEvent);

    expect(transition.tick).toBe(7);
    expect(transition.foodEatenAt).toEqual({ x: 5, y: 5 });
    expect(transition.fatalCollision).toBe(true);
    expect(transition.durationMs).toBe(next.config.tickRateMs);
  });

  it("infers food pickup from score delta when there is no tick event", () => {
    const previous = createGameState({
      food: { x: 4, y: 4 },
    });
    const next = createGameState({
      snakes: [
        createSnake("player1", { score: 1 }),
        createSnake("player2"),
      ],
      food: { x: 9, y: 9 },
    });

    const transition = computeTransition(previous, next, 3);

    expect(transition.foodEatenAt).toEqual({ x: 4, y: 4 });
    expect(transition.fatalCollision).toBe(false);
  });

  it("infers a fatal collision from an alive-to-dead transition without an event", () => {
    const previous = createGameState();
    const next = createGameState({
      snakes: [
        createSnake("player1"),
        createSnake("player2", { alive: false }),
      ],
    });

    const transition = computeTransition(previous, next, 4);

    expect(transition.foodEatenAt).toBeNull();
    expect(transition.fatalCollision).toBe(true);
  });
});

describe("toTickEvent", () => {
  it("returns null when the event tick does not match the current tick", () => {
    expect(
      toTickEvent({
        tick: 9,
        lastEventTick: 8,
        hasConsumedFoodEvent: true,
      }),
    ).toBeNull();
  });

  it("normalizes a network event payload into a shared tick event", () => {
    expect(
      toTickEvent({
        tick: 11,
        lastEventTick: 11,
        hasConsumedFoodEvent: true,
      consumedFoodPosition: { x: 6, y: 2 },
      player1EliminatedThisTick: true,
      player2EliminatedThisTick: false,
      player1ProcessedInputSequence: 9,
      player2ProcessedInputSequence: 4,
    }),
    ).toEqual({
      tick: 11,
      consumedFoodPosition: { x: 6, y: 2 },
      eliminatedSnakeIds: ["player1"],
      processedInputSequences: {
        player1: 9,
        player2: 4,
      },
    });
  });
});

describe("toSharedGameState", () => {
  it("normalizes iterable network payloads and ignores invalid snake records", () => {
    const state = toSharedGameState({
      status: "running",
      width: 28,
      height: 16,
      tickRateMs: 95,
      hasFood: true,
      food: { x: 12, y: 7 },
      winner: "draw",
      snakes: new Set([
        {
          id: "player1",
          direction: "up",
          alive: false,
          score: 7,
          body: new Set([
            { x: 1, y: 1 },
            { x: 1, y: 2 },
          ]),
        },
        {
          id: "spectator",
          direction: "left",
          alive: true,
          score: 1,
          body: [],
        },
        {
          id: "player2",
          direction: "diagonal",
          body: [
            { x: 5, y: 5 },
            null,
            { x: 5, y: 6 },
          ],
        },
      ]),
    });

    expect(state).toEqual({
      status: "running",
      config: {
        width: 28,
        height: 16,
        tickRateMs: 95,
      },
      snakes: [
        {
          id: "player1",
          direction: "up",
          alive: false,
          score: 7,
          body: [
            { x: 1, y: 1 },
            { x: 1, y: 2 },
          ],
        },
        {
          id: "player2",
          direction: "right",
          alive: true,
          score: 0,
          body: [
            { x: 5, y: 5 },
            { x: 5, y: 6 },
          ],
        },
      ],
      food: { x: 12, y: 7 },
      winner: "draw",
    });
  });

  it("falls back to safe defaults for an invalid payload", () => {
    expect(toSharedGameState({ status: "broken", snakes: 42 })).toEqual({
      status: "waiting",
      config: DEFAULT_GAME_CONFIG,
      snakes: [],
      food: null,
      winner: null,
    });
  });
});

describe("session summary helpers", () => {
  it("normalizes session state from network payloads", () => {
    expect(
      toSessionSummary({
        roundNumber: 4,
        player1Wins: 2,
        player2Wins: 1,
      }),
    ).toEqual({
      roundNumber: 4,
      player1Wins: 2,
      player2Wins: 1,
    });
  });

  it("falls back to an empty session when the payload is invalid", () => {
    expect(toSessionSummary({ roundNumber: "oops" })).toEqual(createSessionSummary());
  });
});

describe("network helpers", () => {
  it("normalizes processed input sequences and rng seed", () => {
    expect(
      toProcessedInputSequences({
        player1ProcessedInputSequence: 12,
        player2ProcessedInputSequence: 5,
      }),
    ).toEqual({
      player1: 12,
      player2: 5,
    });

    expect(toRngSeed({ rngSeed: 77 })).toBe(77);
    expect(toRngSeed({ rngSeed: 0 })).toBe(1);
    expect(toNextTickAtMs({ nextTickAtMs: 12_345 })).toBe(12_345);
    expect(toNextTickAtMs({ nextTickAtMs: 0 })).toBeNull();
  });

  it("estimates wrapped correction distance on the controlled snake head", () => {
    const previous = createGameState({
      snakes: [
        createSnake("player1", {
          body: [
            { x: 19, y: 2 },
            { x: 18, y: 2 },
          ],
        }),
        createSnake("player2"),
      ],
    });
    const next = createGameState({
      snakes: [
        createSnake("player1", {
          body: [
            { x: 0, y: 2 },
            { x: 19, y: 2 },
          ],
        }),
        createSnake("player2"),
      ],
    });

    expect(estimateSnakeHeadCorrection(previous, next, "player1")).toBe(1);
  });

  it("merges only the locally controlled snake into the display state", () => {
    const authoritative = createGameState({
      snakes: [
        createSnake("player1"),
        createSnake("player2", {
          body: [
            { x: 8, y: 8 },
            { x: 9, y: 8 },
          ],
        }),
      ],
    });
    const predicted = createGameState({
      snakes: [
        createSnake("player1", {
          direction: "up",
          body: [
            { x: 2, y: 1 },
            { x: 2, y: 2 },
          ],
        }),
        createSnake("player2", {
          direction: "down",
          body: [
            { x: 8, y: 7 },
            { x: 8, y: 8 },
          ],
        }),
      ],
    });

    expect(mergeControlledSnake(authoritative, predicted, "player1")).toEqual({
      ...authoritative,
      snakes: [
        {
          id: "player1",
          alive: true,
          direction: "up",
          score: 0,
          body: [
            { x: 2, y: 1 },
            { x: 2, y: 2 },
          ],
        },
        {
          id: "player2",
          alive: true,
          direction: "left",
          score: 0,
          body: [
            { x: 8, y: 8 },
            { x: 9, y: 8 },
          ],
        },
      ],
    });
  });

  it("compares predicted state fidelity on the controlled snake only", () => {
    const authoritative = createGameState({
      snakes: [
        createSnake("player1", {
          direction: "up",
          body: [
            { x: 2, y: 1 },
            { x: 2, y: 2 },
          ],
        }),
        createSnake("player2", {
          direction: "down",
          body: [
            { x: 8, y: 7 },
            { x: 8, y: 8 },
          ],
        }),
      ],
    });
    const sameLocalSnake = createGameState({
      snakes: [
        createSnake("player1", {
          direction: "up",
          body: [
            { x: 2, y: 1 },
            { x: 2, y: 2 },
          ],
        }),
        createSnake("player2"),
      ],
    });

    expect(areControlledSnakesEquivalent(authoritative, sameLocalSnake, "player1")).toBe(true);
    expect(areControlledSnakesEquivalent(authoritative, sameLocalSnake, "player2")).toBe(false);
  });

  it("maps latency and jitter bands to a stable network quality label", () => {
    expect(toNetworkQuality(null, null)).toBe("unknown");
    expect(toNetworkQuality(30, 4)).toBe("excellent");
    expect(toNetworkQuality(70, 11)).toBe("good");
    expect(toNetworkQuality(110, 22)).toBe("fair");
    expect(toNetworkQuality(160, 40)).toBe("poor");
  });

  it("treats predicted and authoritative states as equivalent only when render data matches", () => {
    const previous = createGameState();
    const same = createGameState();
    const changedScore = createGameState({
      snakes: [
        createSnake("player1", { score: 1 }),
        createSnake("player2"),
      ],
    });

    expect(areGameStatesEquivalent(previous, same)).toBe(true);
    expect(areGameStatesEquivalent(previous, changedScore)).toBe(false);
  });

  it("estimates the server clock offset from a ping exchange", () => {
    expect(
      computeServerClockOffsetMs(
        1_000,
        1_080,
        2_040,
        2_050,
      ),
    ).toBe(1_005);
  });

  it("prefers the aligned next-tick timing over the heuristic fallback", () => {
    expect(
      resolveNextTickDelayMs({
        tickRateMs: 100,
        fallbackDelayMs: 65,
        nextTickAtMs: 5_090,
        estimatedServerNowMs: 5_030,
      }),
    ).toBe(60);

    expect(
      resolveNextTickDelayMs({
        tickRateMs: 100,
        fallbackDelayMs: 65,
        nextTickAtMs: null,
        estimatedServerNowMs: null,
      }),
    ).toBe(65);
  });

  it("offsets future prediction steps by the current prediction lead", () => {
    expect(
      resolvePredictionStepDelayMs({
        tickRateMs: 100,
        fallbackDelayMs: 65,
        nextTickAtMs: 5_090,
        estimatedServerNowMs: 5_105,
        predictionLeadTicks: 1,
      }),
    ).toBe(85);
  });

  it("expands prediction headroom when latency or authoritative gaps get risky", () => {
    expect(
      resolvePredictionLeadLimit({
        latencyMs: null,
        jitterMs: null,
        tickRateMs: 100,
        authoritativeGapMs: null,
      }),
    ).toBe(2);
    expect(
      resolvePredictionLeadLimit({
        latencyMs: 70,
        jitterMs: 10,
        tickRateMs: 100,
        authoritativeGapMs: null,
      }),
    ).toBe(3);
    expect(
      resolvePredictionLeadLimit({
        latencyMs: 45,
        jitterMs: 8,
        tickRateMs: 100,
        authoritativeGapMs: 116,
      }),
    ).toBe(3);
    expect(
      resolvePredictionLeadLimit({
        latencyMs: 45,
        jitterMs: 8,
        tickRateMs: 100,
        authoritativeGapMs: 90,
      }),
    ).toBe(2);
  });

  it("adds interpolation slack for remote entities when jitter grows", () => {
    expect(
      resolveRemoteInterpolationDelayMs({
        tickRateMs: 100,
        latencyMs: null,
        jitterMs: null,
      }),
    ).toBe(100);
    expect(
      resolveRemoteInterpolationDelayMs({
        tickRateMs: 100,
        latencyMs: 36,
        jitterMs: 5,
      }),
    ).toBe(110);
    expect(
      resolveRemoteInterpolationDelayMs({
        tickRateMs: 100,
        latencyMs: 128,
        jitterMs: 18,
      }),
    ).toBe(140);
  });

  it("prefers the lowest-rtt recent clock sample", () => {
    expect(
      selectStableClockOffsetMs([
        { offsetMs: 990, rttMs: 48, receivedAtMs: 1_000 },
        { offsetMs: 1_010, rttMs: 18, receivedAtMs: 1_100 },
        { offsetMs: 1_004, rttMs: 18, receivedAtMs: 1_200 },
      ]),
    ).toBe(1_004);
  });
});

function createGameState(overrides: Partial<GameState> = {}): GameState {
  return {
    status: "running",
    config: DEFAULT_GAME_CONFIG,
    snakes: [createSnake("player1"), createSnake("player2")],
    food: { x: 5, y: 5 },
    winner: null,
    ...overrides,
  };
}

function createSnake(id: SnakeState["id"], overrides: Partial<SnakeState> = {}): SnakeState {
  const defaults =
    id === "player1"
      ? {
          direction: "right" as const,
          body: [
            { x: 2, y: 2 },
            { x: 1, y: 2 },
          ],
        }
      : {
          direction: "left" as const,
          body: [
            { x: 8, y: 8 },
            { x: 9, y: 8 },
          ],
        };

  return {
    id,
    direction: defaults.direction,
    alive: true,
    score: 0,
    body: defaults.body,
    ...overrides,
  };
}

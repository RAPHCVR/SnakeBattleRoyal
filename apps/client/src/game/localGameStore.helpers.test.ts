import { DEFAULT_GAME_CONFIG, type GameState, type SnakeState, type TickEvent } from "@snake-duel/shared";
import { describe, expect, it } from "vitest";
import { computeTransition, toSharedGameState, toTickEvent } from "./localGameStore.helpers.js";

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
    };

    const transition = computeTransition(previous, next, 7, tickEvent);

    expect(transition.tick).toBe(7);
    expect(transition.foodEatenAt).toEqual({ x: 5, y: 5 });
    expect(transition.fatalCollision).toBe(true);
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
      }),
    ).toEqual({
      tick: 11,
      consumedFoodPosition: { x: 6, y: 2 },
      eliminatedSnakeIds: ["player1"],
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

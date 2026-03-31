import { DEFAULT_GAME_CONFIG, type GameState, type SnakeState, type TickEvent } from "@snake-duel/shared";
import { describe, expect, it } from "vitest";
import { SnakeRoomState, applyGameStateToSchema } from "./SnakeRoomState.js";

describe("applyGameStateToSchema", () => {
  it("syncs full game state and tick event flags", () => {
    const state = new SnakeRoomState();
    const game = createGameState({
      status: "game_over",
      winner: "player2",
      food: { x: 7, y: 4 },
      snakes: [
        createSnake("player1", {
          direction: "down",
          score: 3,
          body: [
            { x: 2, y: 2 },
            { x: 2, y: 1 },
            { x: 2, y: 0 },
          ],
        }),
        createSnake("player2", {
          direction: "left",
          body: [
            { x: 8, y: 5 },
            { x: 9, y: 5 },
          ],
        }),
      ],
    });
    const tickEvent: TickEvent = {
      tick: 9,
      consumedFoodPosition: { x: 6, y: 4 },
      eliminatedSnakeIds: ["player1"],
    };
    const session = {
      roundNumber: 3,
      player1Wins: 1,
      player2Wins: 1,
    };

    applyGameStateToSchema(state, game, 9, tickEvent, session);

    expect(state.status).toBe("game_over");
    expect(state.winner).toBe("player2");
    expect(state.tick).toBe(9);
    expect(state.width).toBe(DEFAULT_GAME_CONFIG.width);
    expect(state.height).toBe(DEFAULT_GAME_CONFIG.height);
    expect(state.tickRateMs).toBe(DEFAULT_GAME_CONFIG.tickRateMs);
    expect(state.hasFood).toBe(true);
    expect({ x: state.food.x, y: state.food.y }).toEqual({ x: 7, y: 4 });
    expect(state.lastEventTick).toBe(9);
    expect(state.hasConsumedFoodEvent).toBe(true);
    expect({ x: state.consumedFoodPosition.x, y: state.consumedFoodPosition.y }).toEqual({ x: 6, y: 4 });
    expect(state.player1EliminatedThisTick).toBe(true);
    expect(state.player2EliminatedThisTick).toBe(false);
    expect(state.roundNumber).toBe(3);
    expect(state.player1Wins).toBe(1);
    expect(state.player2Wins).toBe(1);
    expect(state.snakes).toHaveLength(2);
    expect(state.snakes[0]?.id).toBe("player1");
    expect(state.snakes[0]?.body).toHaveLength(3);
    expect(state.snakes[1]?.id).toBe("player2");
    expect(state.snakes[1]?.body).toHaveLength(2);
  });

  it("clears stale food, events and removed snake entries", () => {
    const state = new SnakeRoomState();

    applyGameStateToSchema(
      state,
      createGameState({
        food: { x: 3, y: 6 },
      }),
      4,
      {
        tick: 4,
        consumedFoodPosition: { x: 1, y: 1 },
        eliminatedSnakeIds: ["player2"],
      },
    );

    applyGameStateToSchema(
      state,
      createGameState({
        status: "waiting",
        food: null,
        snakes: [createSnake("player1")],
      }),
      5,
      null,
    );

    expect(state.tick).toBe(5);
    expect(state.hasFood).toBe(false);
    expect({ x: state.food.x, y: state.food.y }).toEqual({ x: 0, y: 0 });
    expect(state.lastEventTick).toBe(0);
    expect(state.hasConsumedFoodEvent).toBe(false);
    expect({ x: state.consumedFoodPosition.x, y: state.consumedFoodPosition.y }).toEqual({ x: 0, y: 0 });
    expect(state.player1EliminatedThisTick).toBe(false);
    expect(state.player2EliminatedThisTick).toBe(false);
    expect(state.roundNumber).toBe(0);
    expect(state.player1Wins).toBe(0);
    expect(state.player2Wins).toBe(0);
    expect(state.snakes).toHaveLength(1);
    expect(state.snakes[0]?.id).toBe("player1");
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
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
        }
      : {
          direction: "left" as const,
          body: [
            { x: 10, y: 10 },
            { x: 11, y: 10 },
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

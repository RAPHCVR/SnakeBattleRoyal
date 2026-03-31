import { describe, expect, it } from "vitest";
import {
  advanceRuntimeTick,
  createEmptyInputBuffers,
  createEmptyProcessedInputSequences,
  createInitialGameState,
  createRuntime,
  createRuntimeFromGameState,
  queueInput,
  type EngineRuntime,
  type InputBuffers,
} from "./engine.js";
import type { GameConfig, GameState, SnakeState } from "./game-types.js";

const BASE_CONFIG: GameConfig = {
  width: 20,
  height: 20,
  tickRateMs: 100,
};

describe("shared snake engine", () => {
  it("rejects grid sizes that cannot produce a playable duel", () => {
    expect(() =>
      createInitialGameState({
        config: {
          ...BASE_CONFIG,
          width: 7,
        },
      }),
    ).toThrow("Grid width must be an integer >= 8.");

    expect(() =>
      createInitialGameState({
        config: {
          ...BASE_CONFIG,
          height: 1,
        },
      }),
    ).toThrow("Grid height must be an integer >= 2.");
  });

  it("initializes default state and spawns food on a free cell", () => {
    const state = createInitialGameState({
      config: BASE_CONFIG,
      random: () => 0,
      initialStatus: "waiting",
    });

    expect(state.snakes).toHaveLength(2);
    expect(state.snakes[0]?.direction).toBe("right");
    expect(state.snakes[1]?.direction).toBe("left");
    expect(state.snakes[0]?.body).toHaveLength(3);
    expect(state.snakes[1]?.body).toHaveLength(3);
    expect(state.food).not.toBeNull();

    const occupied = new Set(state.snakes.flatMap((snake) => snake.body.map((cell) => `${cell.x},${cell.y}`)));
    expect(occupied.has(`${state.food?.x},${state.food?.y}`)).toBe(false);
  });

  it("queues buffered inputs and blocks immediate opposite direction", () => {
    let runtime = createRuntime({
      config: BASE_CONFIG,
      random: () => 0,
      initialStatus: "running",
    });

    const first = queueInput(runtime, "player1", { direction: "up", sequence: 1 }, { maxBufferSize: 3 });
    runtime = first.runtime;
    expect(first.accepted).toBe(true);
    expect(first.reason).toBeNull();

    const opposite = queueInput(runtime, "player1", { direction: "down", sequence: 2 }, { maxBufferSize: 3 });
    runtime = opposite.runtime;
    expect(opposite.accepted).toBe(false);
    expect(opposite.reason).toBe("invalid_direction_change");

    const second = queueInput(runtime, "player1", { direction: "right", sequence: 3 }, { maxBufferSize: 3 });
    runtime = second.runtime;
    expect(second.accepted).toBe(true);

    runtime = advanceRuntimeTick(runtime, () => 0.5);
    const player1AfterTick1 = runtime.game.snakes.find((snake) => snake.id === "player1");
    expect(player1AfterTick1?.direction).toBe("up");
    expect(runtime.processedInputSequences.player1).toBe(1);

    runtime = advanceRuntimeTick(runtime, () => 0.5);
    const player1AfterTick2 = runtime.game.snakes.find((snake) => snake.id === "player1");
    expect(player1AfterTick2?.direction).toBe("right");
    expect(runtime.processedInputSequences.player1).toBe(3);
  });

  it("rebuilds a runtime from an authoritative snapshot", () => {
    const game = makeRunningState();

    const runtime = createRuntimeFromGameState(game, {
      tick: 9,
      processedInputSequences: {
        player1: 4,
        player2: 3,
      },
      rngSeed: 12345,
    });

    expect(runtime.tick).toBe(9);
    expect(runtime.game).toEqual(game);
    expect(runtime.processedInputSequences).toEqual({
      player1: 4,
      player2: 3,
    });
    expect(runtime.rngSeed).toBe(12345);
    expect(runtime.lastTickEvent).toBeNull();
  });

  it("applies wrap-around when crossing grid border", () => {
    const runtime = runtimeFromGameState(
      makeRunningState({
        snakes: [
          makeSnake("player1", "right", true, [
            { x: 19, y: 3 },
            { x: 18, y: 3 },
            { x: 17, y: 3 },
          ]),
          makeSnake("player2", "left", true, [
            { x: 12, y: 10 },
            { x: 13, y: 10 },
            { x: 14, y: 10 },
          ]),
        ],
      }),
    );

    const next = advanceRuntimeTick(runtime, () => 0.3);
    const player1 = next.game.snakes.find((snake) => snake.id === "player1");
    expect(player1?.body[0]).toEqual({ x: 0, y: 3 });
  });

  it("eliminates both snakes on head-to-head same cell collision", () => {
    const runtime = runtimeFromGameState(
      makeRunningState({
        snakes: [
          makeSnake("player1", "right", true, [
            { x: 4, y: 5 },
            { x: 3, y: 5 },
            { x: 2, y: 5 },
          ]),
          makeSnake("player2", "left", true, [
            { x: 6, y: 5 },
            { x: 7, y: 5 },
            { x: 8, y: 5 },
          ]),
        ],
      }),
    );

    const next = advanceRuntimeTick(runtime, () => 0.3);
    expect(next.game.snakes.every((snake) => !snake.alive)).toBe(true);
    expect(next.game.status).toBe("game_over");
    expect(next.game.winner).toBe("draw");
  });

  it("eliminates both snakes on exact cross collision", () => {
    const runtime = runtimeFromGameState(
      makeRunningState({
        snakes: [
          makeSnake("player1", "right", true, [
            { x: 4, y: 8 },
            { x: 3, y: 8 },
            { x: 2, y: 8 },
          ]),
          makeSnake("player2", "left", true, [
            { x: 5, y: 8 },
            { x: 6, y: 8 },
            { x: 7, y: 8 },
          ]),
        ],
      }),
    );

    const next = advanceRuntimeTick(runtime, () => 0.1);
    expect(next.game.snakes.every((snake) => !snake.alive)).toBe(true);
    expect(next.game.status).toBe("game_over");
    expect(next.game.winner).toBe("draw");
  });

  it("kills only the intruding snake when it enters the opponent previous head cell", () => {
    const runtime = runtimeFromGameState(
      makeRunningState({
        snakes: [
          makeSnake("player1", "up", true, [
            { x: 6, y: 4 },
            { x: 6, y: 5 },
            { x: 6, y: 6 },
          ]),
          makeSnake("player2", "right", true, [
            { x: 6, y: 3 },
            { x: 5, y: 3 },
            { x: 4, y: 3 },
          ]),
        ],
      }),
    );

    const next = advanceRuntimeTick(runtime, () => 0.6);
    const player1 = next.game.snakes.find((snake) => snake.id === "player1");
    const player2 = next.game.snakes.find((snake) => snake.id === "player2");

    expect(player1?.alive).toBe(false);
    expect(player2?.alive).toBe(true);
    expect(next.game.status).toBe("game_over");
    expect(next.game.winner).toBe("player2");
  });

  it("allows a snake to enter a tail cell vacated on the same tick", () => {
    const runtime = runtimeFromGameState(
      makeRunningState({
        snakes: [
          makeSnake("player1", "right", true, [
            { x: 2, y: 5 },
            { x: 1, y: 5 },
            { x: 0, y: 5 },
          ]),
          makeSnake("player2", "right", true, [
            { x: 5, y: 5 },
            { x: 4, y: 5 },
            { x: 3, y: 5 },
          ]),
        ],
      }),
    );

    const next = advanceRuntimeTick(runtime, () => 0.7);
    const player1 = next.game.snakes.find((snake) => snake.id === "player1");
    const player2 = next.game.snakes.find((snake) => snake.id === "player2");

    expect(player1?.alive).toBe(true);
    expect(player2?.alive).toBe(true);
    expect(player1?.body[0]).toEqual({ x: 3, y: 5 });
    expect(next.game.status).toBe("running");
    expect(next.game.winner).toBeNull();
  });

  it("still blocks access to a tail cell when the other snake grows and keeps that segment", () => {
    const runtime = runtimeFromGameState(
      makeRunningState({
        snakes: [
          makeSnake("player1", "right", true, [
            { x: 2, y: 5 },
            { x: 1, y: 5 },
            { x: 0, y: 5 },
          ]),
          makeSnake("player2", "right", true, [
            { x: 5, y: 5 },
            { x: 4, y: 5 },
            { x: 3, y: 5 },
          ]),
        ],
        food: { x: 6, y: 5 },
      }),
    );

    const next = advanceRuntimeTick(runtime, () => 0.2);
    const player1 = next.game.snakes.find((snake) => snake.id === "player1");
    const player2 = next.game.snakes.find((snake) => snake.id === "player2");

    expect(player1?.alive).toBe(false);
    expect(player2?.alive).toBe(true);
    expect(player2?.score).toBe(1);
    expect(next.game.status).toBe("game_over");
    expect(next.game.winner).toBe("player2");
  });

  it("grows snake, increments score and respawns food immediately after eating", () => {
    const runtime = runtimeFromGameState(
      makeRunningState({
        snakes: [
          makeSnake("player1", "right", true, [
            { x: 2, y: 2 },
            { x: 1, y: 2 },
            { x: 0, y: 2 },
          ]),
          makeSnake("player2", "left", true, [
            { x: 15, y: 15 },
            { x: 16, y: 15 },
            { x: 17, y: 15 },
          ]),
        ],
        food: { x: 3, y: 2 },
      }),
    );

    const next = advanceRuntimeTick(runtime, () => 0);
    const player1 = next.game.snakes.find((snake) => snake.id === "player1");

    expect(player1?.score).toBe(1);
    expect(player1?.body).toHaveLength(4);
    expect(player1?.body[0]).toEqual({ x: 3, y: 2 });
    expect(next.game.food).not.toBeNull();

    const occupied = new Set(next.game.snakes.flatMap((snake) => snake.body.map((cell) => `${cell.x},${cell.y}`)));
    expect(occupied.has(`${next.game.food?.x},${next.game.food?.y}`)).toBe(false);
    expect(next.lastTickEvent?.consumedFoodPosition).toEqual({ x: 3, y: 2 });
    expect(next.lastTickEvent?.eliminatedSnakeIds).toEqual([]);
    expect(next.lastTickEvent?.processedInputSequences).toEqual(createEmptyProcessedInputSequences());
  });

  it("publishes eliminated snakes in the tick event", () => {
    const runtime = runtimeFromGameState(
      makeRunningState({
        snakes: [
          makeSnake("player1", "right", true, [
            { x: 4, y: 5 },
            { x: 3, y: 5 },
            { x: 2, y: 5 },
          ]),
          makeSnake("player2", "left", true, [
            { x: 6, y: 5 },
            { x: 7, y: 5 },
            { x: 8, y: 5 },
          ]),
        ],
      }),
    );

    const next = advanceRuntimeTick(runtime, () => 0.3);
    expect(next.lastTickEvent?.tick).toBe(1);
    expect(next.lastTickEvent?.consumedFoodPosition).toBeNull();
    expect(next.lastTickEvent?.eliminatedSnakeIds).toEqual(["player1", "player2"]);
    expect(next.lastTickEvent?.processedInputSequences).toEqual(createEmptyProcessedInputSequences());
  });

  it("carries the highest processed input sequence into the tick event", () => {
    let runtime = createRuntime({
      config: BASE_CONFIG,
      initialStatus: "running",
      seed: 9,
    });

    runtime = queueInput(runtime, "player1", { direction: "up", sequence: 6 }).runtime;
    runtime = queueInput(runtime, "player2", { direction: "down", sequence: 3 }).runtime;

    const next = advanceRuntimeTick(runtime);

    expect(next.processedInputSequences).toEqual({
      player1: 6,
      player2: 3,
    });
    expect(next.lastTickEvent?.processedInputSequences).toEqual({
      player1: 6,
      player2: 3,
    });
  });
});

function makeRunningState(overrides: Partial<GameState> = {}): GameState {
  return {
    status: "running",
    config: BASE_CONFIG,
    snakes: overrides.snakes ?? [
      makeSnake("player1", "right", true, [
        { x: 2, y: 10 },
        { x: 1, y: 10 },
        { x: 0, y: 10 },
      ]),
      makeSnake("player2", "left", true, [
        { x: 17, y: 10 },
        { x: 18, y: 10 },
        { x: 19, y: 10 },
      ]),
    ],
    food: overrides.food ?? { x: 10, y: 2 },
    winner: overrides.winner ?? null,
  };
}

function makeSnake(
  id: SnakeState["id"],
  direction: SnakeState["direction"],
  alive: boolean,
  body: SnakeState["body"],
  score = 0,
): SnakeState {
  return {
    id,
    body,
    direction,
    alive,
    score,
  };
}

function runtimeFromGameState(game: GameState, inputBuffers?: InputBuffers): EngineRuntime {
  return {
    tick: 0,
    game,
    inputBuffers: inputBuffers ?? createEmptyInputBuffers(),
    processedInputSequences: createEmptyProcessedInputSequences(),
    rngSeed: 1,
    lastTickEvent: null,
  };
}

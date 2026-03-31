import {
  DEFAULT_GAME_CONFIG,
  type Direction,
  type GameState,
  type GridPosition,
  type ProcessedInputSequences,
  type SnakeId,
  type SnakeState,
  type TickEvent,
  type Winner,
} from "@snake-duel/shared";

export interface TickTransition {
  readonly tick: number;
  readonly previous: GameState;
  readonly next: GameState;
  readonly foodEatenAt: GridPosition | null;
  readonly fatalCollision: boolean;
  readonly durationMs: number;
}

export interface SessionSummary {
  readonly roundNumber: number;
  readonly player1Wins: number;
  readonly player2Wins: number;
}

export type NetworkQuality = "unknown" | "excellent" | "good" | "fair" | "poor";

type AnyRecord = Record<string, unknown>;

export function createSessionSummary(
  override: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    roundNumber: 0,
    player1Wins: 0,
    player2Wins: 0,
    ...override,
  };
}

export function computeTransition(
  previous: GameState,
  next: GameState,
  tick: number,
  tickEvent: TickEvent | null = null,
  durationMs = next.config.tickRateMs,
): TickTransition {
  const beforeFood = previous.food ? { ...previous.food } : null;
  const foodEatenAt = tickEvent?.consumedFoodPosition
    ? { ...tickEvent.consumedFoodPosition }
    : hasAnyScoreIncrement(previous, next)
      ? beforeFood
      : null;
  const fatalCollision = tickEvent
    ? tickEvent.eliminatedSnakeIds.length > 0
    : previous.snakes.some((snakeBefore) => {
        const snakeAfter = next.snakes.find((snake) => snake.id === snakeBefore.id);
        return Boolean(snakeBefore.alive && snakeAfter && !snakeAfter.alive);
      });

  return {
    tick,
    previous,
    next,
    foodEatenAt,
    fatalCollision,
    durationMs,
  };
}

export function toSharedGameState(networkState: unknown): GameState {
  const data = isRecord(networkState) ? networkState : {};
  const winner = toWinner(data.winner);
  const food = toBoolean(data.hasFood, false) ? toGridPosition(data.food) : null;

  return {
    status: toGameStatus(data.status),
    config: {
      width: toFiniteNumber(data.width, DEFAULT_GAME_CONFIG.width),
      height: toFiniteNumber(data.height, DEFAULT_GAME_CONFIG.height),
      tickRateMs: toFiniteNumber(data.tickRateMs, DEFAULT_GAME_CONFIG.tickRateMs),
    },
    snakes: toSnakes(data.snakes),
    food,
    winner,
  };
}

export function toTickEvent(networkState: unknown): TickEvent | null {
  const data = isRecord(networkState) ? networkState : {};
  const tick = toFiniteNumber(data.tick, 0);
  const eventTick = toFiniteNumber(data.lastEventTick, 0);

  if (tick === 0 || eventTick !== tick) {
    return null;
  }

  const eliminatedSnakeIds: SnakeId[] = [];
  if (toBoolean(data.player1EliminatedThisTick, false)) {
    eliminatedSnakeIds.push("player1");
  }
  if (toBoolean(data.player2EliminatedThisTick, false)) {
    eliminatedSnakeIds.push("player2");
  }

  return {
    tick,
    consumedFoodPosition: toBoolean(data.hasConsumedFoodEvent, false)
      ? toGridPosition(data.consumedFoodPosition)
      : null,
    eliminatedSnakeIds,
    processedInputSequences: toProcessedInputSequences(networkState),
  };
}

export function toSessionSummary(networkState: unknown): SessionSummary {
  const data = isRecord(networkState) ? networkState : {};

  return createSessionSummary({
    roundNumber: toFiniteNumber(data.roundNumber, 0),
    player1Wins: toFiniteNumber(data.player1Wins, 0),
    player2Wins: toFiniteNumber(data.player2Wins, 0),
  });
}

export function toProcessedInputSequences(networkState: unknown): ProcessedInputSequences {
  const data = isRecord(networkState) ? networkState : {};

  return {
    player1: toFiniteNumber(data.player1ProcessedInputSequence, 0),
    player2: toFiniteNumber(data.player2ProcessedInputSequence, 0),
  };
}

export function toRngSeed(networkState: unknown): number {
  const data = isRecord(networkState) ? networkState : {};
  return Math.max(1, toFiniteNumber(data.rngSeed, 1));
}

export function estimateSnakeHeadCorrection(
  previous: GameState,
  next: GameState,
  snakeId: SnakeId,
): number {
  const previousSnake = previous.snakes.find((snake) => snake.id === snakeId);
  const nextSnake = next.snakes.find((snake) => snake.id === snakeId);
  const previousHead = previousSnake?.body[0];
  const nextHead = nextSnake?.body[0];

  if (!previousHead || !nextHead) {
    return 0;
  }

  const dx = Math.abs(previousHead.x - nextHead.x);
  const dy = Math.abs(previousHead.y - nextHead.y);
  const wrappedDx = Math.min(dx, Math.max(0, previous.config.width - dx));
  const wrappedDy = Math.min(dy, Math.max(0, previous.config.height - dy));

  return wrappedDx + wrappedDy;
}

export function toNetworkQuality(
  latencyMs: number | null,
  jitterMs: number | null,
): NetworkQuality {
  if (latencyMs === null || jitterMs === null) {
    return "unknown";
  }

  if (latencyMs <= 45 && jitterMs <= 8) {
    return "excellent";
  }

  if (latencyMs <= 85 && jitterMs <= 16) {
    return "good";
  }

  if (latencyMs <= 130 && jitterMs <= 28) {
    return "fair";
  }

  return "poor";
}

function hasAnyScoreIncrement(previous: GameState, next: GameState): boolean {
  for (const previousSnake of previous.snakes) {
    const nextSnake = next.snakes.find((snake) => snake.id === previousSnake.id);
    if (!nextSnake) {
      continue;
    }
    if (nextSnake.score > previousSnake.score) {
      return true;
    }
  }
  return false;
}

function toSnakes(value: unknown): SnakeState[] {
  if (!Array.isArray(value) && !isIterable(value)) {
    return [];
  }

  const array = Array.isArray(value) ? value : Array.from(value);
  const snakes: SnakeState[] = [];

  for (const item of array) {
    if (!isRecord(item)) {
      continue;
    }

    const id = toSnakeId(item.id);
    if (!id) {
      continue;
    }

    snakes.push({
      id,
      direction: toDirection(item.direction) ?? "right",
      alive: toBoolean(item.alive, true),
      score: toFiniteNumber(item.score, 0),
      body: toBody(item.body),
    });
  }

  return snakes;
}

function toBody(value: unknown): GridPosition[] {
  if (!Array.isArray(value) && !isIterable(value)) {
    return [];
  }
  const array = Array.isArray(value) ? value : Array.from(value);
  return array.map((segment) => toGridPosition(segment)).filter(Boolean) as GridPosition[];
}

function toGridPosition(value: unknown): GridPosition | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    x: toFiniteNumber(value.x, 0),
    y: toFiniteNumber(value.y, 0),
  };
}

function toSnakeId(value: unknown): SnakeId | null {
  return value === "player1" || value === "player2" ? value : null;
}

function toDirection(value: unknown): Direction | null {
  return value === "up" || value === "down" || value === "left" || value === "right"
    ? value
    : null;
}

function toWinner(value: unknown): Winner {
  if (value === "player1" || value === "player2" || value === "draw") {
    return value;
  }
  return null;
}

function toGameStatus(value: unknown): GameState["status"] {
  if (value === "waiting" || value === "running" || value === "paused" || value === "game_over") {
    return value;
  }
  return "waiting";
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null;
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return Boolean(value) && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
}

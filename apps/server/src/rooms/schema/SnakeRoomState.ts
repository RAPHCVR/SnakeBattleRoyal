import { ArraySchema, Schema, type } from "@colyseus/schema";
import {
  createEmptyProcessedInputSequences,
  type GameState,
  type GridPosition,
  type ProcessedInputSequences,
  type SnakeState,
  type TickEvent,
} from "@snake-duel/shared";

export interface RoundSessionState {
  readonly roundNumber: number;
  readonly player1Wins: number;
  readonly player2Wins: number;
}

export interface RoomRuntimeState {
  readonly processedInputSequences: ProcessedInputSequences;
  readonly rngSeed: number;
}

export interface RoomCountdownState {
  readonly endsAtMs: number | null;
  readonly durationMs: number;
}

export class GridPositionSchema extends Schema {
  @type("number") public x = 0;
  @type("number") public y = 0;
}

export class SnakeSchema extends Schema {
  @type("string") public id = "";
  @type("string") public direction = "right";
  @type("boolean") public alive = true;
  @type("number") public score = 0;
  @type([GridPositionSchema]) public body = new ArraySchema<GridPositionSchema>();
}

export class SnakeRoomState extends Schema {
  @type("string") public status = "waiting";
  @type("string") public winner = "";

  @type("number") public width = 20;
  @type("number") public height = 20;
  @type("number") public tickRateMs = 100;
  @type("number") public tick = 0;
  @type("number") public rngSeed = 1;

  @type([SnakeSchema]) public snakes = new ArraySchema<SnakeSchema>();

  @type(GridPositionSchema) public food = new GridPositionSchema();
  @type("boolean") public hasFood = false;

  @type("number") public lastEventTick = 0;
  @type(GridPositionSchema) public consumedFoodPosition = new GridPositionSchema();
  @type("boolean") public hasConsumedFoodEvent = false;
  @type("boolean") public player1EliminatedThisTick = false;
  @type("boolean") public player2EliminatedThisTick = false;
  @type("number") public player1ProcessedInputSequence = 0;
  @type("number") public player2ProcessedInputSequence = 0;

  @type("number") public connectedPlayers = 0;
  @type("boolean") public player1Rematch = false;
  @type("boolean") public player2Rematch = false;
  @type("number") public roundNumber = 0;
  @type("number") public player1Wins = 0;
  @type("number") public player2Wins = 0;
  @type("number") public countdownEndsAtMs = 0;
  @type("number") public countdownDurationMs = 0;
}

export function applyGameStateToSchema(
  state: SnakeRoomState,
  game: GameState,
  tick: number,
  tickEvent: TickEvent | null = null,
  session: RoundSessionState = { roundNumber: 0, player1Wins: 0, player2Wins: 0 },
  runtime: RoomRuntimeState = {
    processedInputSequences: createEmptyProcessedInputSequences(),
    rngSeed: 1,
  },
  countdown: RoomCountdownState = {
    endsAtMs: null,
    durationMs: 0,
  },
): void {
  state.status = game.status;
  state.winner = game.winner ?? "";
  state.width = game.config.width;
  state.height = game.config.height;
  state.tickRateMs = game.config.tickRateMs;
  state.tick = tick;
  state.rngSeed = runtime.rngSeed;

  syncSnakeArray(state.snakes, game.snakes);
  syncFood(state, game.food);
  syncTickEvent(state, tickEvent);
  syncRuntimeState(state, runtime);
  syncSession(state, session);
  syncCountdown(state, countdown);
}

function syncSnakeArray(target: ArraySchema<SnakeSchema>, next: readonly SnakeState[]): void {
  while (target.length > next.length) {
    target.pop();
  }

  for (let index = 0; index < next.length; index += 1) {
    const nextSnake = next[index];
    if (!nextSnake) {
      continue;
    }

    const existing = target[index];
    const snakeSchema = existing ?? createSnakeSchema();
    if (!existing) {
      target.push(snakeSchema);
    }

    snakeSchema.id = nextSnake.id;
    snakeSchema.direction = nextSnake.direction;
    snakeSchema.alive = nextSnake.alive;
    snakeSchema.score = nextSnake.score;
    syncBody(snakeSchema.body, nextSnake.body);
  }
}

function syncBody(target: ArraySchema<GridPositionSchema>, next: readonly GridPosition[]): void {
  while (target.length > next.length) {
    target.pop();
  }

  for (let index = 0; index < next.length; index += 1) {
    const nextSegment = next[index];
    if (!nextSegment) {
      continue;
    }

    const existing = target[index];
    const segmentSchema = existing ?? createGridPositionSchema();
    if (!existing) {
      target.push(segmentSchema);
    }

    segmentSchema.x = nextSegment.x;
    segmentSchema.y = nextSegment.y;
  }
}

function syncFood(state: SnakeRoomState, food: GridPosition | null): void {
  if (!food) {
    state.hasFood = false;
    state.food.x = 0;
    state.food.y = 0;
    return;
  }

  state.hasFood = true;
  state.food.x = food.x;
  state.food.y = food.y;
}

function syncTickEvent(state: SnakeRoomState, tickEvent: TickEvent | null): void {
  if (!tickEvent) {
    state.lastEventTick = 0;
    state.hasConsumedFoodEvent = false;
    state.consumedFoodPosition.x = 0;
    state.consumedFoodPosition.y = 0;
    state.player1EliminatedThisTick = false;
    state.player2EliminatedThisTick = false;
    return;
  }

  state.lastEventTick = tickEvent.tick;
  if (tickEvent.consumedFoodPosition) {
    state.hasConsumedFoodEvent = true;
    state.consumedFoodPosition.x = tickEvent.consumedFoodPosition.x;
    state.consumedFoodPosition.y = tickEvent.consumedFoodPosition.y;
  } else {
    state.hasConsumedFoodEvent = false;
    state.consumedFoodPosition.x = 0;
    state.consumedFoodPosition.y = 0;
  }

  const eliminated = new Set(tickEvent.eliminatedSnakeIds);
  state.player1EliminatedThisTick = eliminated.has("player1");
  state.player2EliminatedThisTick = eliminated.has("player2");
}

function syncRuntimeState(state: SnakeRoomState, runtime: RoomRuntimeState): void {
  state.rngSeed = runtime.rngSeed;
  state.player1ProcessedInputSequence = runtime.processedInputSequences.player1;
  state.player2ProcessedInputSequence = runtime.processedInputSequences.player2;
}

function syncSession(state: SnakeRoomState, session: RoundSessionState): void {
  state.roundNumber = session.roundNumber;
  state.player1Wins = session.player1Wins;
  state.player2Wins = session.player2Wins;
}

function syncCountdown(state: SnakeRoomState, countdown: RoomCountdownState): void {
  state.countdownEndsAtMs = countdown.endsAtMs ?? 0;
  state.countdownDurationMs = countdown.durationMs > 0 ? countdown.durationMs : 0;
}

function createSnakeSchema(): SnakeSchema {
  return new SnakeSchema();
}

function createGridPositionSchema(): GridPositionSchema {
  return new GridPositionSchema();
}

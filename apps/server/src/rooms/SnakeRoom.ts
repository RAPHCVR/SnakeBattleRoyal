import { Client, Room } from "@colyseus/core";
import {
  DEFAULT_GAME_CONFIG,
  SnakeGameEngine,
  isDirection,
  type Direction,
  type SnakeId,
  type TickEvent,
  type Winner,
} from "@snake-duel/shared";
import {
  SnakeRoomState,
  applyGameStateToSchema,
  type RoundSessionState,
} from "./schema/SnakeRoomState.js";

interface InputMessage {
  readonly direction: Direction;
}

const PLAYER_IDS: readonly SnakeId[] = ["player1", "player2"];
const EMPTY_ROOM_TIMEOUT_MS = 10_000;

export class SnakeRoom extends Room<{ state: SnakeRoomState }> {
  public override maxClients = 2;
  public override autoDispose = true;
  public override maxMessagesPerSecond = 45;

  private readonly engine = new SnakeGameEngine({
    config: DEFAULT_GAME_CONFIG,
    initialStatus: "waiting",
    inputBufferSize: 3,
  });

  private readonly sessionToPlayer = new Map<string, SnakeId>();
  private readonly occupiedSlots = new Set<SnakeId>();
  private readonly rematchVotes = new Set<SnakeId>();
  private session: RoundSessionState = createRoundSessionState();
  private roundResultRecorded = false;
  private emptyRoomTimeout: ReturnType<typeof setTimeout> | null = null;

  public override onCreate(): void {
    this.setMetadata({
      gameMode: "snake_duel",
      tickRateMs: DEFAULT_GAME_CONFIG.tickRateMs,
    });

    this.setState(new SnakeRoomState());
    this.pushEngineState();

    this.setSimulationInterval(() => {
      const before = this.engine.getTick();
      const beforeEvent = this.engine.getLastTickEvent();
      this.engine.tick();
      this.recordRoundResultIfNeeded(this.engine.getState().winner);
      const after = this.engine.getTick();
      const afterEvent = this.engine.getLastTickEvent();

      if (shouldPushEngineStateUpdate(before, beforeEvent, after, afterEvent)) {
        this.pushEngineState(afterEvent);
      }
    }, DEFAULT_GAME_CONFIG.tickRateMs);

    this.onMessage<InputMessage>("input", (client, payload) => {
      const slot = this.sessionToPlayer.get(client.sessionId);
      if (!slot) {
        return;
      }
      if (!payload || !isDirection(payload.direction)) {
        return;
      }

      this.engine.enqueueInput(slot, payload.direction);
    });

    this.onMessage("rematch", (client) => {
      if (this.engine.getState().status !== "game_over") {
        return;
      }

      const slot = this.sessionToPlayer.get(client.sessionId);
      if (!slot) {
        return;
      }

      this.rematchVotes.add(slot);
      this.syncRematchVotes();

      if (this.rematchVotes.size === 2) {
        this.startRunningMatch();
      }
    });
  }

  public override onJoin(client: Client): void {
    this.clearEmptyRoomTimeout();

    const slot = this.assignSlot(client.sessionId);
    this.state.connectedPlayers = this.clients.length;

    client.send("seat", { snakeId: slot });
    this.broadcast("system", {
      type: "player_joined",
      players: this.clients.length,
    });

    if (this.clients.length === this.maxClients && this.engine.getState().status === "waiting") {
      this.startRunningMatch();
      return;
    }

    this.pushEngineState();
  }

  public override onLeave(client: Client): void {
    const slot = this.sessionToPlayer.get(client.sessionId);
    if (slot) {
      this.sessionToPlayer.delete(client.sessionId);
      this.occupiedSlots.delete(slot);
      this.rematchVotes.delete(slot);
    }

    this.state.connectedPlayers = this.clients.length;
    this.syncRematchVotes();

    if (this.clients.length === 0) {
      this.scheduleEmptyRoomCleanup();
      this.resetSession();
      this.engine.reset("waiting");
      this.pushEngineState();
      return;
    }

    this.resetSession();
    this.engine.reset("waiting");
    this.pushEngineState();
    this.broadcast("system", {
      type: "player_left",
      players: this.clients.length,
    });
  }

  public override onDispose(): void {
    this.clearEmptyRoomTimeout();
  }

  private startRunningMatch(): void {
    this.rematchVotes.clear();
    this.syncRematchVotes();
    this.roundResultRecorded = false;
    this.session = {
      ...this.session,
      roundNumber: this.session.roundNumber > 0 ? this.session.roundNumber + 1 : 1,
    };
    this.engine.reset("running");
    this.pushEngineState();
    this.broadcast("system", {
      type: "match_started",
      tickRateMs: DEFAULT_GAME_CONFIG.tickRateMs,
    });
  }

  private pushEngineState(tickEvent: TickEvent | null = null): void {
    applyGameStateToSchema(
      this.state,
      this.engine.getState(),
      this.engine.getTick(),
      tickEvent,
      this.session,
    );
    this.state.connectedPlayers = this.clients.length;
    this.syncRematchVotes();
  }

  private syncRematchVotes(): void {
    this.state.player1Rematch = this.rematchVotes.has("player1");
    this.state.player2Rematch = this.rematchVotes.has("player2");
  }

  private assignSlot(sessionId: string): SnakeId {
    for (const slot of PLAYER_IDS) {
      if (this.occupiedSlots.has(slot)) {
        continue;
      }

      this.occupiedSlots.add(slot);
      this.sessionToPlayer.set(sessionId, slot);
      return slot;
    }

    throw new Error("No available player slot.");
  }

  private scheduleEmptyRoomCleanup(): void {
    this.clearEmptyRoomTimeout();
    this.emptyRoomTimeout = setTimeout(() => {
      if (this.clients.length === 0) {
        void this.disconnect();
      }
    }, EMPTY_ROOM_TIMEOUT_MS);
  }

  private clearEmptyRoomTimeout(): void {
    if (!this.emptyRoomTimeout) {
      return;
    }
    clearTimeout(this.emptyRoomTimeout);
    this.emptyRoomTimeout = null;
  }

  private resetSession(): void {
    this.session = createRoundSessionState();
    this.roundResultRecorded = false;
  }

  private recordRoundResultIfNeeded(winner: Winner): void {
    if (this.roundResultRecorded || this.engine.getState().status !== "game_over") {
      return;
    }

    if (winner === "player1") {
      this.session = {
        ...this.session,
        player1Wins: this.session.player1Wins + 1,
      };
    } else if (winner === "player2") {
      this.session = {
        ...this.session,
        player2Wins: this.session.player2Wins + 1,
      };
    }

    this.roundResultRecorded = true;
  }
}

function createRoundSessionState(): RoundSessionState {
  return {
    roundNumber: 0,
    player1Wins: 0,
    player2Wins: 0,
  };
}

export function shouldPushEngineStateUpdate(
  beforeTick: number,
  beforeEvent: TickEvent | null,
  afterTick: number,
  afterEvent: TickEvent | null,
): boolean {
  if (afterTick !== beforeTick) {
    return true;
  }

  return didTickEventChange(beforeEvent, afterEvent);
}

function didTickEventChange(beforeEvent: TickEvent | null, afterEvent: TickEvent | null): boolean {
  if (beforeEvent === afterEvent) {
    return false;
  }

  if (!beforeEvent || !afterEvent) {
    return beforeEvent !== afterEvent;
  }

  if (beforeEvent.tick !== afterEvent.tick) {
    return true;
  }

  if (!isSamePosition(beforeEvent.consumedFoodPosition, afterEvent.consumedFoodPosition)) {
    return true;
  }

  if (beforeEvent.eliminatedSnakeIds.length !== afterEvent.eliminatedSnakeIds.length) {
    return true;
  }

  return beforeEvent.eliminatedSnakeIds.some((snakeId, index) => snakeId !== afterEvent.eliminatedSnakeIds[index]);
}

function isSamePosition(
  a: TickEvent["consumedFoodPosition"],
  b: TickEvent["consumedFoodPosition"],
): boolean {
  if (a === b) {
    return true;
  }

  if (!a || !b) {
    return a === b;
  }

  return a.x === b.x && a.y === b.y;
}

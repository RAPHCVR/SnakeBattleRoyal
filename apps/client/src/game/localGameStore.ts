import { Client, type Room } from "@colyseus/sdk";
import { WebSocketTransport } from "@colyseus/sdk/transport/WebSocketTransport";
import {
  DEFAULT_GAME_CONFIG,
  SnakeGameEngine,
  type Direction,
  type GameState,
  type SnakeId,
} from "@snake-duel/shared";
import { create } from "zustand";
import {
  computeTransition,
  createSessionSummary,
  toSessionSummary,
  toSharedGameState,
  toTickEvent,
  type SessionSummary,
  type TickTransition,
} from "./localGameStore.helpers.js";

export type { TickTransition } from "./localGameStore.helpers.js";

export type ClientMode = "menu" | "local" | "matchmaking" | "online";

interface RematchVotes {
  readonly player1: boolean;
  readonly player2: boolean;
}

interface OnlineSessionState {
  readonly connecting: boolean;
  readonly roomId: string | null;
  readonly ownSnakeId: SnakeId | null;
  readonly connectedPlayers: number;
  readonly roomStatus: GameState["status"] | null;
  readonly waitingForOpponent: boolean;
  readonly rematchVotes: RematchVotes;
  readonly rematchVoted: boolean;
  readonly waitingOpponentRematch: boolean;
  readonly lastError: string | null;
}

interface LocalGameStoreState {
  readonly mode: ClientMode;
  readonly gameState: GameState;
  readonly transition: TickTransition | null;
  readonly renderVersion: number;
  readonly session: SessionSummary;
  readonly online: OnlineSessionState;
  startLocalGame: () => void;
  restartLocalGame: () => void;
  startOnlineMatchmaking: () => void;
  cancelMatchmaking: () => void;
  voteRematch: () => void;
  returnToMenu: () => void;
  enqueueLocalInput: (snakeId: SnakeId, direction: Direction) => boolean;
  enqueueOnlineInput: (direction: Direction) => boolean;
  togglePause: () => void;
}

const engine = new SnakeGameEngine({
  config: DEFAULT_GAME_CONFIG,
  initialStatus: "waiting",
});

const COLYSEUS_URL = import.meta.env.VITE_COLYSEUS_URL ?? "ws://localhost:2567";

let localLoopHandle: number | null = null;
let onlineClient: Client | null = null;
let onlineRoom: Room | null = null;
let matchmakingGeneration = 0;
let transitionTimeoutHandle: number | null = null;
let browserTransportPatched = false;
let localManualTimeControl = false;
let localManualTimeRemainderMs = 0;

type StoreSetState = (recipe: (state: LocalGameStoreState) => Partial<LocalGameStoreState>) => void;
type StoreGetState = () => LocalGameStoreState;

let storeSetState: StoreSetState | null = null;
let storeGetState: StoreGetState | null = null;

interface BrowserWebSocketTransportShape {
  ws: WebSocket;
  protocols?: string | string[];
  events: {
    onopen?: (event: Event) => void;
    onmessage?: (event: MessageEvent) => void;
    onclose?: (event: CloseEvent) => void;
    onerror?: (event: Event) => void;
  };
}

function createOnlineSessionState(
  override: Partial<OnlineSessionState> = {},
): OnlineSessionState {
  return {
    connecting: false,
    roomId: null,
    ownSnakeId: null,
    connectedPlayers: 0,
    roomStatus: null,
    waitingForOpponent: false,
    rematchVotes: { player1: false, player2: false },
    rematchVoted: false,
    waitingOpponentRematch: false,
    lastError: null,
    ...override,
  };
}

function createNewSession(): SessionSummary {
  return createSessionSummary({ roundNumber: 1 });
}

function advanceSessionRound(session: SessionSummary): SessionSummary {
  const currentRound = session.roundNumber > 0 ? session.roundNumber : 0;
  return createSessionSummary({
    ...session,
    roundNumber: currentRound + 1,
  });
}

function applyWinnerToSession(
  session: SessionSummary,
  winner: GameState["winner"],
): SessionSummary {
  if (winner === "player1") {
    return createSessionSummary({
      ...session,
      player1Wins: session.player1Wins + 1,
    });
  }

  if (winner === "player2") {
    return createSessionSummary({
      ...session,
      player2Wins: session.player2Wins + 1,
    });
  }

  return session;
}

function stopTickLoop(): void {
  if (localLoopHandle === null) {
    return;
  }
  window.clearInterval(localLoopHandle);
  localLoopHandle = null;
}

function resetLocalManualTimeControl(): void {
  localManualTimeControl = false;
  localManualTimeRemainderMs = 0;
}

function enableLocalManualTimeControl(): void {
  if (localManualTimeControl) {
    return;
  }

  stopTickLoop();
  localManualTimeControl = true;
  localManualTimeRemainderMs = 0;
}

function clearTransitionTimer(): void {
  if (transitionTimeoutHandle === null) {
    return;
  }
  window.clearTimeout(transitionTimeoutHandle);
  transitionTimeoutHandle = null;
}

function ensureBrowserTransportPatch(): void {
  if (browserTransportPatched || typeof window === "undefined") {
    return;
  }

  const originalConnect = WebSocketTransport.prototype.connect;

  WebSocketTransport.prototype.connect = function patchedConnect(
    this: BrowserWebSocketTransportShape,
    url: string,
    headers?: unknown,
  ): void {
    if (typeof window.WebSocket !== "function") {
      originalConnect.call(this as WebSocketTransport, url, headers);
      return;
    }

    const ws = this.protocols
      ? new window.WebSocket(url, this.protocols)
      : new window.WebSocket(url);

    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = (event) => this.events.onopen?.(event);
    ws.onmessage = (event) => this.events.onmessage?.(event);
    ws.onclose = (event) => this.events.onclose?.(event);
    ws.onerror = (event) => this.events.onerror?.(event);
  };

  browserTransportPatched = true;
}

function stopOnlineRoom(consented: boolean): void {
  if (!onlineRoom) {
    return;
  }

  const room = onlineRoom;
  onlineRoom = null;
  room.removeAllListeners();
  void room.leave(consented).catch(() => undefined);
}

function isLocallyPlaying(state: GameState): boolean {
  return state.status === "running" || state.status === "paused";
}

function scheduleTransitionClear(
  setState: StoreSetState,
  transition: TickTransition,
): void {
  clearTransitionTimer();
  transitionTimeoutHandle = window.setTimeout(() => {
    setState((state) => {
      if (!state.transition || state.transition.tick !== transition.tick) {
        return state;
      }

      return {
        ...state,
        transition: null,
        renderVersion: state.renderVersion + (transition.fatalCollision ? 1 : 0),
      };
    });
    transitionTimeoutHandle = null;
  }, transition.next.config.tickRateMs);
}

function runLocalSimulationStep(setState: StoreSetState): boolean {
  const beforeTick = engine.getTick();
  const previous = engine.getState();
  const next = engine.tick();
  const afterTick = engine.getTick();
  const tickEvent = engine.getLastTickEvent();

  if (afterTick === beforeTick) {
    return false;
  }

  const transition = computeTransition(previous, next, afterTick, tickEvent);
  setState((state) => ({
    ...state,
    gameState: next,
    transition,
    renderVersion: state.renderVersion + 1,
    session:
      previous.status !== "game_over" && next.status === "game_over"
        ? applyWinnerToSession(state.session, next.winner)
        : state.session,
  }));
  scheduleTransitionClear(setState, transition);

  if (next.status === "game_over") {
    stopTickLoop();
  }

  return true;
}

function startLocalTickLoop(setState: StoreSetState): void {
  resetLocalManualTimeControl();
  stopTickLoop();
  const tickDuration = DEFAULT_GAME_CONFIG.tickRateMs;

  localLoopHandle = window.setInterval(() => {
    runLocalSimulationStep(setState);
  }, tickDuration);
}

function advanceLocalSimulationByMs(ms: number): number {
  const setState = storeSetState;
  const getState = storeGetState;

  if (!setState || !getState) {
    return 0;
  }

  const state = getState();
  if (state.mode !== "local" || state.gameState.status !== "running") {
    return 0;
  }

  const normalizedMs = Number.isFinite(ms) ? ms : 0;
  if (normalizedMs <= 0) {
    return 0;
  }

  const tickDuration = Math.max(1, state.gameState.config.tickRateMs);
  enableLocalManualTimeControl();
  localManualTimeRemainderMs += normalizedMs;

  const steps = Math.floor(localManualTimeRemainderMs / tickDuration);
  if (steps < 1) {
    return 0;
  }

  localManualTimeRemainderMs -= steps * tickDuration;

  let advanced = 0;
  for (let index = 0; index < steps; index += 1) {
    if (engine.getState().status !== "running") {
      localManualTimeRemainderMs = 0;
      break;
    }

    if (!runLocalSimulationStep(setState)) {
      break;
    }

    advanced += 1;
  }

  return advanced;
}

async function startOnlineMatchmaking(
  setState: StoreSetState,
): Promise<void> {
  resetLocalManualTimeControl();
  stopTickLoop();
  stopOnlineRoom(true);
  clearTransitionTimer();

  const generation = ++matchmakingGeneration;
  setState((state) => ({
    ...state,
    mode: "matchmaking",
    gameState: engine.reset("waiting"),
    transition: null,
    session: createSessionSummary(),
    online: createOnlineSessionState({
      connecting: true,
      lastError: null,
    }),
    renderVersion: state.renderVersion + 1,
  }));

  try {
    ensureBrowserTransportPatch();
    onlineClient ??= new Client(COLYSEUS_URL);
    const room = await onlineClient.joinOrCreate("snake_duel");

    if (generation !== matchmakingGeneration) {
      room.removeAllListeners();
      await room.leave(true).catch(() => undefined);
      return;
    }

    onlineRoom = room;

    room.onMessage<{ snakeId?: unknown }>("seat", (payload) => {
      const seat = toSnakeId(payload?.snakeId);
      if (!seat) {
        return;
      }

      setState((state) => ({
        ...state,
        online: createOnlineSessionState({
          ...state.online,
          connecting: false,
          roomId: room.roomId,
          ownSnakeId: seat,
          connectedPlayers: Math.max(state.online.connectedPlayers, 1),
          rematchVoted: seat === "player1" ? state.online.rematchVotes.player1 : state.online.rematchVotes.player2,
          waitingOpponentRematch: false,
        }),
      }));
    });

    room.onStateChange((networkState) => {
      const previousGame = useLocalGameStore.getState().gameState;
      const nextGame = toSharedGameState(networkState);
      const tick = toFiniteNumber((networkState as AnyRecord).tick, 0);
      const tickEvent = toTickEvent(networkState);
      const transition = computeTransition(previousGame, nextGame, tick, tickEvent);
      const connectedPlayers = toFiniteNumber((networkState as AnyRecord).connectedPlayers, 0);
      const waitingForOpponent = nextGame.status === "waiting" && connectedPlayers < 2;
      const rematchVotes = {
        player1: toBoolean((networkState as AnyRecord).player1Rematch, false),
        player2: toBoolean((networkState as AnyRecord).player2Rematch, false),
      };

      setState((state) => {
        const ownId = state.online.ownSnakeId;
        const rematchVoted = ownId
          ? ownId === "player1"
            ? rematchVotes.player1
            : rematchVotes.player2
          : false;
        const waitingOpponentRematch = ownId
          ? rematchVoted &&
            !(ownId === "player1" ? rematchVotes.player2 : rematchVotes.player1)
          : false;

        return {
          ...state,
          mode: "online",
          gameState: nextGame,
          transition,
          renderVersion: state.renderVersion + 1,
          session: toSessionSummary(networkState),
          online: createOnlineSessionState({
            ...state.online,
            connecting: false,
            roomId: room.roomId,
            connectedPlayers,
            roomStatus: nextGame.status,
            waitingForOpponent,
            rematchVotes,
            rematchVoted,
            waitingOpponentRematch,
            lastError: null,
          }),
        };
      });
      scheduleTransitionClear(setState, transition);
    });

    room.onLeave((code, reason) => {
      if (generation !== matchmakingGeneration) {
        return;
      }

      onlineRoom = null;
      clearTransitionTimer();
      setState((state) => ({
        ...state,
        mode: "menu",
        gameState: engine.reset("waiting"),
        transition: null,
        session: createSessionSummary(),
        online: createOnlineSessionState({
          lastError: `Connexion fermée (${code})${reason ? `: ${reason}` : ""}`,
        }),
        renderVersion: state.renderVersion + 1,
      }));
    });

    room.onError((code, message) => {
      if (generation !== matchmakingGeneration) {
        return;
      }

      onlineRoom = null;
      room.removeAllListeners();
      clearTransitionTimer();
      setState((state) => ({
        ...state,
        mode: "menu",
        gameState: engine.reset("waiting"),
        transition: null,
        session: createSessionSummary(),
        online: createOnlineSessionState({
          ...state.online,
          connecting: false,
          lastError: `Erreur réseau (${code})${message ? `: ${message}` : ""}`,
        }),
        renderVersion: state.renderVersion + 1,
      }));
    });
  } catch (error) {
    if (generation !== matchmakingGeneration) {
      return;
    }

    const message = error instanceof Error ? error.message : "Connexion matchmaking impossible.";
    clearTransitionTimer();
    setState((state) => ({
      ...state,
      mode: "menu",
      gameState: engine.reset("waiting"),
      transition: null,
      online: createOnlineSessionState({
        lastError: message,
      }),
      renderVersion: state.renderVersion + 1,
    }));
  }
}

export const useLocalGameStore = create<LocalGameStoreState>((set, get) => {
  storeSetState = set;
  storeGetState = get;

  return {
    mode: "menu",
    gameState: engine.getState(),
    transition: null,
    renderVersion: 0,
    session: createSessionSummary(),
    online: createOnlineSessionState(),
    startLocalGame: () => {
      resetLocalManualTimeControl();
      matchmakingGeneration += 1;
      stopOnlineRoom(true);
      clearTransitionTimer();
      const next = engine.reset("running");
      set((state) => ({
        ...state,
        mode: "local",
        gameState: next,
        transition: null,
        session: createNewSession(),
        online: createOnlineSessionState(),
        renderVersion: state.renderVersion + 1,
      }));
      startLocalTickLoop(set);
    },
    restartLocalGame: () => {
      resetLocalManualTimeControl();
      clearTransitionTimer();
      const next = engine.reset("running");
      set((state) => ({
        ...state,
        mode: "local",
        gameState: next,
        transition: null,
        session: advanceSessionRound(state.session),
        renderVersion: state.renderVersion + 1,
      }));
      startLocalTickLoop(set);
    },
    startOnlineMatchmaking: () => {
      void startOnlineMatchmaking(set);
    },
    cancelMatchmaking: () => {
      resetLocalManualTimeControl();
      matchmakingGeneration += 1;
      stopOnlineRoom(true);
      clearTransitionTimer();
      const waiting = engine.reset("waiting");
      set((state) => ({
        ...state,
        mode: "menu",
        gameState: waiting,
        transition: null,
        session: createSessionSummary(),
        online: createOnlineSessionState(),
        renderVersion: state.renderVersion + 1,
      }));
    },
    voteRematch: () => {
      const state = get();
      if (state.mode !== "online" || state.gameState.status !== "game_over" || !onlineRoom) {
        return;
      }

      onlineRoom.send("rematch");
    },
    returnToMenu: () => {
      resetLocalManualTimeControl();
      matchmakingGeneration += 1;
      stopTickLoop();
      stopOnlineRoom(true);
      clearTransitionTimer();
      const waiting = engine.reset("waiting");
      set((state) => ({
        ...state,
        mode: "menu",
        gameState: waiting,
        transition: null,
        session: createSessionSummary(),
        online: createOnlineSessionState(),
        renderVersion: state.renderVersion + 1,
      }));
    },
    enqueueLocalInput: (snakeId, direction) => {
      const currentState = engine.getState();
      if (!isLocallyPlaying(currentState) || currentState.status === "paused") {
        return false;
      }
      return engine.enqueueInput(snakeId, direction);
    },
    enqueueOnlineInput: (direction) => {
      const state = get();
      if (state.mode !== "online" || state.gameState.status !== "running" || !onlineRoom) {
        return false;
      }

      onlineRoom.send("input", { direction });
      return true;
    },
    togglePause: () => {
      const state = get();
      if (state.mode !== "local") {
        return;
      }

      const current = engine.getState();
      if (current.status === "game_over" || current.status === "waiting") {
        return;
      }

      const nextStatus = current.status === "running" ? "paused" : "running";
      const next = engine.setStatus(nextStatus);

      set((store) => ({
        ...store,
        gameState: next,
        transition: null,
        renderVersion: store.renderVersion + 1,
      }));
    },
  };
});

export function destroyLocalGameLoop(): void {
  resetLocalManualTimeControl();
  stopTickLoop();
  stopOnlineRoom(true);
  clearTransitionTimer();
}

type AnyRecord = Record<string, unknown>;

function renderGameToText(): string {
  const state = useLocalGameStore.getState();
  const payload = {
    mode: state.mode,
    coordinateSystem: {
      origin: "top-left",
      xAxis: "increases to the right",
      yAxis: "increases downward",
    },
    game: {
      status: state.gameState.status,
      tickRateMs: state.gameState.config.tickRateMs,
      food: state.gameState.food,
      snakes: state.gameState.snakes.map((snake) => ({
        id: snake.id,
        alive: snake.alive,
        direction: snake.direction,
        score: snake.score,
        body: snake.body,
      })),
    },
    online: {
      roomId: state.online.roomId,
      ownSnakeId: state.online.ownSnakeId,
      connectedPlayers: state.online.connectedPlayers,
      waitingForOpponent: state.online.waitingForOpponent,
      waitingOpponentRematch: state.online.waitingOpponentRematch,
    },
    automation: {
      manualTimeControl: localManualTimeControl,
    },
    session: state.session,
  };

  return JSON.stringify(payload);
}

function installAutomationHooks(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.render_game_to_text = renderGameToText;
  window.advanceTime = (ms: number) => advanceLocalSimulationByMs(ms);
}

function toSnakeId(value: unknown): SnakeId | null {
  return value === "player1" || value === "player2" ? value : null;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

installAutomationHooks();

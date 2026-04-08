import { Client, type Room } from "@colyseus/sdk";
import { WebSocketTransport } from "@colyseus/sdk/transport/WebSocketTransport";
import {
  DEFAULT_GAME_CONFIG,
  SnakeGameEngine,
  advanceRuntimeTick,
  createEmptyProcessedInputSequences,
  createRuntimeFromGameState,
  queueInput,
  type Direction,
  type EngineRuntime,
  type GameState,
  type ProcessedInputSequences,
  type QueueInputRejectReason,
  type SnakeId,
} from "@snake-duel/shared";
import { create } from "zustand";
import {
  areControlledSnakesEquivalent,
  type ClockOffsetSample,
  computeServerClockOffsetMs,
  computeTransition,
  createSessionSummary,
  estimateSnakeHeadCorrection,
  mergeControlledSnake,
  resolvePredictionLeadLimit,
  resolvePredictionStepDelayMs,
  selectStableClockOffsetMs,
  toNetworkQuality,
  toNextTickAtMs,
  toProcessedInputSequences,
  toRngSeed,
  toSessionSummary,
  toSharedGameState,
  toTickEvent,
  type NetworkQuality,
  type SessionSummary,
  type TickTransition,
} from "./localGameStore.helpers.js";

export type { TickTransition } from "./localGameStore.helpers.js";

export type ClientMode = "menu" | "local" | "matchmaking" | "online";

declare global {
  interface Window {
    __SNAKE_DUEL_CONFIG__?: {
      colyseusUrl?: string;
    };
  }
}

interface RematchVotes {
  readonly player1: boolean;
  readonly player2: boolean;
}

interface OnlineNetworkState {
  readonly latencyMs: number | null;
  readonly jitterMs: number | null;
  readonly quality: NetworkQuality;
  readonly pendingInputs: number;
  readonly lastSentSequence: number;
  readonly lastProcessedSequence: number;
  readonly correctionCount: number;
  readonly lastCorrectionDistance: number;
  readonly predictionLeadTicks: number;
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
  readonly authoritativeTick: number;
  readonly displayTick: number;
  readonly network: OnlineNetworkState;
}

interface MatchCountdownState {
  readonly active: boolean;
  readonly endsAtMs: number | null;
  readonly durationMs: number;
  readonly source: "none" | "local" | "online";
}

interface LocalGameStoreState {
  readonly mode: ClientMode;
  readonly gameState: GameState;
  readonly transition: TickTransition | null;
  readonly renderVersion: number;
  readonly session: SessionSummary;
  readonly online: OnlineSessionState;
  readonly countdown: MatchCountdownState;
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

function resolveColyseusUrl(): string {
  const runtimeUrl =
    typeof window === "undefined" ? undefined : window.__SNAKE_DUEL_CONFIG__?.colyseusUrl?.trim();
  if (runtimeUrl) {
    return runtimeUrl;
  }

  const buildTimeUrl = import.meta.env.VITE_COLYSEUS_URL?.trim();
  if (buildTimeUrl) {
    return buildTimeUrl;
  }

  return "ws://localhost:2567";
}

const COLYSEUS_URL = resolveColyseusUrl();
const ONLINE_INPUT_BUFFER_SIZE = 3;
const ONLINE_PING_INTERVAL_MS = 1_000;
const ONLINE_LATENCY_EWMA_ALPHA = 0.25;
const ONLINE_JITTER_EWMA_ALPHA = 0.2;
const ONLINE_CLOCK_OFFSET_EWMA_ALPHA = 0.2;
const ONLINE_CLOCK_SAMPLE_LIMIT = 8;
const ONLINE_MIN_PREDICTION_DELAY_MS = 1;
const ONLINE_PREDICTION_SPIN_THRESHOLD_MS = 12;
const ONLINE_PREDICTION_HISTORY_LIMIT = 8;
const ONLINE_MIN_AUTHORITATIVE_TRANSITION_RATIO = 0.72;
const ROUND_START_COUNTDOWN_MS = 3_000;

let localLoopHandle: number | null = null;
let onlineClient: Client | null = null;
let onlineRoom: Room | null = null;
let matchmakingGeneration = 0;
let transitionTimeoutHandle: number | null = null;
let roundCountdownTimeoutHandle: number | null = null;
let browserTransportPatched = false;
let localManualTimeControl = false;
let localManualTimeRemainderMs = 0;
let onlinePredictionTimeoutHandle: number | null = null;
let onlinePredictionDueAtMs: number | null = null;
let onlinePredictionAnimationFrameHandle: number | null = null;
let onlinePingIntervalHandle: number | null = null;
let onlinePredictionRuntime: EngineRuntime | null = null;
let onlinePredictedHistory: EngineRuntime[] = [];
let onlineAuthoritativeState: GameState | null = null;
let onlineAuthoritativeTick = 0;
let onlineNextTickAtMs: number | null = null;
let onlineAuthoritativeProcessedInputs: ProcessedInputSequences = createEmptyProcessedInputSequences();
let onlineAuthoritativeRngSeed = 1;
let onlinePendingInputs: PendingOnlineInput[] = [];
let onlineNextInputSequence = 1;
let onlinePingNonce = 1;
let onlineOutstandingPings = new Map<number, PendingOnlinePing>();
let onlineLatencyMs: number | null = null;
let onlineJitterMs: number | null = null;
let onlineLastRttSampleMs: number | null = null;
let onlineClockOffsetMs: number | null = null;
let onlineClockSamples: ClockOffsetSample[] = [];
let onlineCorrectionCount = 0;
let onlineLastCorrectionDistance = 0;

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

interface PendingOnlineInput {
  readonly sequence: number;
  readonly direction: Direction;
}

interface PendingOnlinePing {
  readonly perfSentAtMs: number;
  readonly wallSentAtMs: number;
}

interface InputFeedbackMessage {
  readonly sequence?: number;
  readonly accepted?: boolean;
  readonly reason?: QueueInputRejectReason | null;
}

interface PongMessage {
  readonly nonce?: number;
  readonly clientSentAtMs?: number;
  readonly serverReceivedAtMs?: number;
  readonly serverSentAtMs?: number;
}

function createOnlineNetworkState(
  override: Partial<OnlineNetworkState> = {},
): OnlineNetworkState {
  return {
    latencyMs: null,
    jitterMs: null,
    quality: "unknown",
    pendingInputs: 0,
    lastSentSequence: 0,
    lastProcessedSequence: 0,
    correctionCount: 0,
    lastCorrectionDistance: 0,
    predictionLeadTicks: 0,
    ...override,
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
    authoritativeTick: 0,
    displayTick: 0,
    network: createOnlineNetworkState(),
    ...override,
  };
}

function createCountdownState(
  override: Partial<MatchCountdownState> = {},
): MatchCountdownState {
  return {
    active: false,
    endsAtMs: null,
    durationMs: 0,
    source: "none",
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

function clearRoundCountdownTimer(): void {
  if (roundCountdownTimeoutHandle === null) {
    return;
  }

  window.clearTimeout(roundCountdownTimeoutHandle);
  roundCountdownTimeoutHandle = null;
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

function stopOnlinePredictionLoop(): void {
  if (onlinePredictionTimeoutHandle !== null) {
    window.clearTimeout(onlinePredictionTimeoutHandle);
    onlinePredictionTimeoutHandle = null;
  }

  if (onlinePredictionAnimationFrameHandle !== null) {
    window.cancelAnimationFrame(onlinePredictionAnimationFrameHandle);
    onlinePredictionAnimationFrameHandle = null;
  }

  onlinePredictionDueAtMs = null;
}

function stopOnlinePingLoop(): void {
  if (onlinePingIntervalHandle !== null) {
    window.clearInterval(onlinePingIntervalHandle);
    onlinePingIntervalHandle = null;
  }

  onlineOutstandingPings.clear();
}

function resetOnlineRuntimeState(): void {
  stopOnlinePredictionLoop();
  stopOnlinePingLoop();
  onlinePredictionRuntime = null;
  onlinePredictedHistory = [];
  onlineAuthoritativeState = null;
  onlineAuthoritativeTick = 0;
  onlineNextTickAtMs = null;
  onlineAuthoritativeProcessedInputs = createEmptyProcessedInputSequences();
  onlineAuthoritativeRngSeed = 1;
  onlinePendingInputs = [];
  onlineNextInputSequence = 1;
  onlinePingNonce = 1;
  onlineLatencyMs = null;
  onlineJitterMs = null;
  onlineLastRttSampleMs = null;
  onlineClockOffsetMs = null;
  onlineClockSamples = [];
  onlineCorrectionCount = 0;
  onlineLastCorrectionDistance = 0;
}

function activateLocalRound(setState: StoreSetState): void {
  clearRoundCountdownTimer();
  const next = engine.setStatus("running");
  setState((state) => ({
    ...state,
    gameState: next,
    countdown: createCountdownState(),
    renderVersion: state.renderVersion + 1,
  }));
  startLocalTickLoop(setState);
}

function stopOnlineRoom(consented: boolean): void {
  stopOnlinePredictionLoop();
  stopOnlinePingLoop();

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
  }, transition.durationMs);
}

function updateOnlineNetworkMetrics(sampleRttMs: number): void {
  if (!Number.isFinite(sampleRttMs) || sampleRttMs < 0) {
    return;
  }

  if (onlineLatencyMs === null) {
    onlineLatencyMs = sampleRttMs;
  } else {
    onlineLatencyMs += (sampleRttMs - onlineLatencyMs) * ONLINE_LATENCY_EWMA_ALPHA;
  }

  const jitterSample = onlineLastRttSampleMs === null ? 0 : Math.abs(sampleRttMs - onlineLastRttSampleMs);
  if (onlineJitterMs === null) {
    onlineJitterMs = jitterSample;
  } else {
    onlineJitterMs += (jitterSample - onlineJitterMs) * ONLINE_JITTER_EWMA_ALPHA;
  }

  onlineLastRttSampleMs = sampleRttMs;
}

function recordOnlineClockSample(sampleOffsetMs: number | null, sampleRttMs: number): void {
  if (
    sampleOffsetMs === null ||
    !Number.isFinite(sampleOffsetMs) ||
    !Number.isFinite(sampleRttMs) ||
    sampleRttMs < 0
  ) {
    return;
  }

  onlineClockSamples = [
    ...onlineClockSamples,
    {
      offsetMs: sampleOffsetMs,
      rttMs: sampleRttMs,
      receivedAtMs: Date.now(),
    },
  ].slice(-ONLINE_CLOCK_SAMPLE_LIMIT);

  const stableOffsetMs = selectStableClockOffsetMs(onlineClockSamples);
  if (stableOffsetMs === null) {
    return;
  }

  if (onlineClockOffsetMs === null) {
    onlineClockOffsetMs = stableOffsetMs;
  } else {
    onlineClockOffsetMs +=
      (stableOffsetMs - onlineClockOffsetMs) * ONLINE_CLOCK_OFFSET_EWMA_ALPHA;
  }
}

function getEstimatedServerNowMs(): number | null {
  return onlineClockOffsetMs === null ? null : Date.now() + onlineClockOffsetMs;
}

function getEstimatedOneWayDelayMs(tickRateMs: number): number {
  if (onlineLatencyMs !== null) {
    return Math.max(0, Math.round(onlineLatencyMs / 2));
  }

  return Math.round(tickRateMs * 0.45);
}

function computeHeuristicPredictionDelayMs(tickRateMs: number): number {
  const estimatedDelay = tickRateMs - getEstimatedOneWayDelayMs(tickRateMs);
  return Math.max(ONLINE_MIN_PREDICTION_DELAY_MS, Math.min(tickRateMs, Math.round(estimatedDelay)));
}

function getPredictionLeadLimit(): number {
  return resolvePredictionLeadLimit({
    latencyMs: onlineLatencyMs,
    jitterMs: onlineJitterMs,
  });
}

function computeOnlinePredictionDelayMs(
  tickRateMs: number,
  currentPredictionTick = onlinePredictionRuntime?.tick ?? onlineAuthoritativeTick,
): number {
  return resolvePredictionStepDelayMs({
    tickRateMs,
    fallbackDelayMs: computeHeuristicPredictionDelayMs(tickRateMs),
    nextTickAtMs: onlineNextTickAtMs,
    estimatedServerNowMs: getEstimatedServerNowMs(),
    predictionLeadTicks: Math.max(0, currentPredictionTick - onlineAuthoritativeTick),
  });
}

function computeCorrectionTransitionDurationMs(tickRateMs: number): number {
  return Math.max(36, Math.min(tickRateMs, Math.round(tickRateMs * 0.45)));
}

function computeAuthoritativeTransitionDurationMs(
  tickRateMs: number,
  status: GameState["status"],
  correctionActive: boolean,
  correctionDistance: number,
): number {
  if (status !== "running") {
    return tickRateMs;
  }

  if (correctionActive && correctionDistance > 0) {
    return computeCorrectionTransitionDurationMs(tickRateMs);
  }

  return Math.max(
    Math.round(tickRateMs * ONLINE_MIN_AUTHORITATIVE_TRANSITION_RATIO),
    computeOnlinePredictionDelayMs(tickRateMs, onlineAuthoritativeTick),
  );
}

function getOwnProcessedSequence(
  ownSnakeId: SnakeId | null,
  processedInputs: ProcessedInputSequences,
): number {
  if (ownSnakeId === "player1") {
    return processedInputs.player1;
  }

  if (ownSnakeId === "player2") {
    return processedInputs.player2;
  }

  return 0;
}

function getPredictionLeadTicks(displayTick: number, authoritativeTick: number): number {
  return Math.max(0, displayTick - authoritativeTick);
}

function getOnlineNetworkSnapshot(
  ownSnakeId: SnakeId | null,
  displayTick: number,
  authoritativeTick: number,
): OnlineNetworkState {
  const roundedLatency = onlineLatencyMs === null ? null : Math.round(onlineLatencyMs);
  const roundedJitter = onlineJitterMs === null ? null : Math.round(onlineJitterMs);

  return createOnlineNetworkState({
    latencyMs: roundedLatency,
    jitterMs: roundedJitter,
    quality: toNetworkQuality(roundedLatency, roundedJitter),
    pendingInputs: onlinePendingInputs.length,
    lastSentSequence: Math.max(0, onlineNextInputSequence - 1),
    lastProcessedSequence: getOwnProcessedSequence(ownSnakeId, onlineAuthoritativeProcessedInputs),
    correctionCount: onlineCorrectionCount,
    lastCorrectionDistance: onlineLastCorrectionDistance,
    predictionLeadTicks: getPredictionLeadTicks(displayTick, authoritativeTick),
  });
}

function resetPredictedHistory(runtime: EngineRuntime): void {
  onlinePredictedHistory = [runtime];
}

function recordPredictedRuntime(runtime: EngineRuntime): void {
  const nextHistory = onlinePredictedHistory.filter(
    (sample) => sample.tick !== runtime.tick && sample.tick > onlineAuthoritativeTick,
  );
  nextHistory.push(runtime);
  nextHistory.sort((a, b) => a.tick - b.tick);
  onlinePredictedHistory = nextHistory.slice(-ONLINE_PREDICTION_HISTORY_LIMIT);
}

function prunePredictedHistory(authoritativeTick: number): void {
  onlinePredictedHistory = onlinePredictedHistory
    .filter((sample) => sample.tick > authoritativeTick)
    .slice(-ONLINE_PREDICTION_HISTORY_LIMIT);
}

function findMatchingPredictedRuntime(
  targetTick: number,
  authoritativeGame: GameState,
  ownSnakeId: SnakeId | null,
): EngineRuntime | null {
  for (let index = onlinePredictedHistory.length - 1; index >= 0; index -= 1) {
    const runtime = onlinePredictedHistory[index];
    if (!runtime) {
      continue;
    }

    if (runtime.tick < targetTick) {
      break;
    }

    if (
      runtime.tick === targetTick &&
      areControlledSnakesEquivalent(authoritativeGame, runtime.game, ownSnakeId)
    ) {
      return runtime;
    }
  }

  return null;
}

function pruneAcknowledgedPendingInputs(
  ownSnakeId: SnakeId | null,
  processedInputs: ProcessedInputSequences,
): void {
  if (!ownSnakeId) {
    onlinePendingInputs = [];
    return;
  }

  const acknowledgedSequence = getOwnProcessedSequence(ownSnakeId, processedInputs);
  onlinePendingInputs = onlinePendingInputs.filter(
    (pendingInput) => pendingInput.sequence > acknowledgedSequence,
  );
}

function rebuildOnlinePredictionRuntime(ownSnakeId: SnakeId | null): EngineRuntime | null {
  if (!onlineAuthoritativeState) {
    return null;
  }

  let runtime = createRuntimeFromGameState(onlineAuthoritativeState, {
    tick: onlineAuthoritativeTick,
    processedInputSequences: onlineAuthoritativeProcessedInputs,
    rngSeed: onlineAuthoritativeRngSeed,
  });

  if (!ownSnakeId) {
    onlinePendingInputs = [];
    return runtime;
  }

  const acknowledgedSequence = getOwnProcessedSequence(ownSnakeId, onlineAuthoritativeProcessedInputs);
  const replayableInputs: PendingOnlineInput[] = [];

  for (const pendingInput of onlinePendingInputs) {
    if (pendingInput.sequence <= acknowledgedSequence) {
      continue;
    }

    const result = queueInput(
      runtime,
      ownSnakeId,
      { direction: pendingInput.direction, sequence: pendingInput.sequence },
      { maxBufferSize: ONLINE_INPUT_BUFFER_SIZE },
    );

    runtime = result.runtime;
    if (result.accepted) {
      replayableInputs.push(pendingInput);
    }
  }

  onlinePendingInputs = replayableInputs;
  return runtime;
}

function scheduleOnlinePredictionStep(
  setState: StoreSetState,
  stepDelayMs: number,
): void {
  const state = storeGetState?.();
  if (!state || state.mode !== "online" || state.gameState.status !== "running") {
    stopOnlinePredictionLoop();
    return;
  }

  if (!onlinePredictionRuntime) {
    stopOnlinePredictionLoop();
    return;
  }

  if (onlinePredictionRuntime.tick >= onlineAuthoritativeTick + getPredictionLeadLimit()) {
    stopOnlinePredictionLoop();
    return;
  }

  const normalizedDelayMs = Math.max(1, Math.round(stepDelayMs));
  const nextDueAtMs = performance.now() + normalizedDelayMs;
  if (
    onlinePredictionTimeoutHandle !== null &&
    onlinePredictionDueAtMs !== null &&
    onlinePredictionDueAtMs <= nextDueAtMs + 1
  ) {
    return;
  }

  stopOnlinePredictionLoop();
  onlinePredictionDueAtMs = nextDueAtMs;

  onlinePredictionTimeoutHandle = window.setTimeout(() => {
    onlinePredictionTimeoutHandle = null;
    flushOnlinePredictionWhenDue(setState);
  }, Math.max(0, normalizedDelayMs - ONLINE_PREDICTION_SPIN_THRESHOLD_MS));
}

function flushOnlinePredictionWhenDue(setState: StoreSetState): void {
  if (onlinePredictionDueAtMs === null) {
    onlinePredictionAnimationFrameHandle = null;
    return;
  }

  if (performance.now() + 0.5 < onlinePredictionDueAtMs) {
    onlinePredictionAnimationFrameHandle = window.requestAnimationFrame(() => {
      flushOnlinePredictionWhenDue(setState);
    });
    return;
  }

  onlinePredictionDueAtMs = null;
  onlinePredictionAnimationFrameHandle = null;
  runOnlinePredictionStep(setState);
}

function runOnlinePredictionStep(
  setState: StoreSetState,
): boolean {
  const state = storeGetState?.();
  if (!state || state.mode !== "online" || state.gameState.status !== "running") {
    return false;
  }

  if (!onlinePredictionRuntime) {
    return false;
  }

  if (onlinePredictionRuntime.tick >= onlineAuthoritativeTick + getPredictionLeadLimit()) {
    return false;
  }

  const previousRuntime = onlinePredictionRuntime;
  const nextRuntime = advanceRuntimeTick(previousRuntime);
  if (nextRuntime.tick === previousRuntime.tick) {
    return false;
  }

  onlinePredictionRuntime = nextRuntime;
  recordPredictedRuntime(nextRuntime);
  const displayGame = mergeControlledSnake(
    onlineAuthoritativeState ?? state.gameState,
    nextRuntime.game,
    state.online.ownSnakeId,
  );
  const transition = computeTransition(
    state.gameState,
    displayGame,
    nextRuntime.tick,
    nextRuntime.lastTickEvent,
    nextRuntime.game.config.tickRateMs,
  );

  setState((store) => ({
    ...store,
    gameState: displayGame,
    transition,
    renderVersion: store.renderVersion + 1,
    online: createOnlineSessionState({
      ...store.online,
      displayTick: nextRuntime.tick,
      network: getOnlineNetworkSnapshot(store.online.ownSnakeId, nextRuntime.tick, store.online.authoritativeTick),
    }),
  }));
  scheduleTransitionClear(setState, transition);

  if (nextRuntime.game.status === "running") {
    scheduleOnlinePredictionStep(
      setState,
      computeOnlinePredictionDelayMs(nextRuntime.game.config.tickRateMs, nextRuntime.tick),
    );
  }

  return true;
}

function startOnlinePingLoop(): void {
  stopOnlinePingLoop();

  const room = onlineRoom;
  if (!room) {
    return;
  }

  const sendPing = () => {
    const nonce = onlinePingNonce++;
    const perfSentAtMs = performance.now();
    const clientSentAtMs = Date.now();
    onlineOutstandingPings.set(nonce, {
      perfSentAtMs,
      wallSentAtMs: clientSentAtMs,
    });
    room.send("ping", { nonce, clientSentAtMs });
  };

  sendPing();
  onlinePingIntervalHandle = window.setInterval(sendPing, ONLINE_PING_INTERVAL_MS);
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
  resetOnlineRuntimeState();
  clearTransitionTimer();
  clearRoundCountdownTimer();

  const generation = ++matchmakingGeneration;
  setState((state) => ({
    ...state,
    mode: "matchmaking",
    gameState: engine.reset("waiting"),
    transition: null,
    session: createSessionSummary(),
    countdown: createCountdownState(),
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

      const rebuiltRuntime = rebuildOnlinePredictionRuntime(seat);
      if (rebuiltRuntime) {
        onlinePredictionRuntime = rebuiltRuntime;
        resetPredictedHistory(rebuiltRuntime);
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
          network: getOnlineNetworkSnapshot(seat, state.online.displayTick, state.online.authoritativeTick),
        }),
      }));
    });

    room.onMessage<InputFeedbackMessage>("input_feedback", (payload) => {
      const sequence = toFiniteNumber(payload?.sequence, 0);
      if (sequence < 1 || payload?.accepted !== false) {
        return;
      }

      onlinePendingInputs = onlinePendingInputs.filter((pendingInput) => pendingInput.sequence !== sequence);
      const ownSnakeId = useLocalGameStore.getState().online.ownSnakeId;
      const rebuiltRuntime = rebuildOnlinePredictionRuntime(ownSnakeId);
      if (rebuiltRuntime) {
        onlinePredictionRuntime = rebuiltRuntime;
        resetPredictedHistory(rebuiltRuntime);
      }

      setState((state) => ({
        ...state,
        online: createOnlineSessionState({
          ...state.online,
          network: getOnlineNetworkSnapshot(
            state.online.ownSnakeId,
            state.online.displayTick,
            state.online.authoritativeTick,
          ),
        }),
      }));
    });

    room.onMessage<PongMessage>("pong", (payload) => {
      const nonce = toFiniteNumber(payload?.nonce, 0);
      if (nonce < 1) {
        return;
      }

      const pendingPing = onlineOutstandingPings.get(nonce);
      if (pendingPing === undefined) {
        return;
      }

      onlineOutstandingPings.delete(nonce);
      const sampleRttMs = Math.max(0, performance.now() - pendingPing.perfSentAtMs);
      updateOnlineNetworkMetrics(sampleRttMs);
      recordOnlineClockSample(
        computeServerClockOffsetMs(
          pendingPing.wallSentAtMs,
          Date.now(),
          toFiniteNumber(payload?.serverReceivedAtMs, 0),
          toFiniteNumber(payload?.serverSentAtMs, 0),
        ),
        sampleRttMs,
      );

      setState((state) => ({
        ...state,
        online: createOnlineSessionState({
          ...state.online,
          network: getOnlineNetworkSnapshot(
            state.online.ownSnakeId,
            state.online.displayTick,
            state.online.authoritativeTick,
          ),
        }),
      }));
    });

    room.onStateChange((networkState) => {
      const currentStore = useLocalGameStore.getState();
      const previousGame = currentStore.gameState;
      const previousDisplayTick = currentStore.online.displayTick;
      const nextGame = toSharedGameState(networkState);
      const tick = toFiniteNumber((networkState as AnyRecord).tick, 0);
      const tickEvent = toTickEvent(networkState);
      const processedInputs = toProcessedInputSequences(networkState);
      const rngSeed = toRngSeed(networkState);
      const nextTickAtMs = nextGame.status === "running" ? toNextTickAtMs(networkState) : null;
      const connectedPlayers = toFiniteNumber((networkState as AnyRecord).connectedPlayers, 0);
      const countdownEndsAtMs = toFiniteNumber((networkState as AnyRecord).countdownEndsAtMs, 0);
      const countdownDurationMs = toFiniteNumber((networkState as AnyRecord).countdownDurationMs, 0);
      const waitingForOpponent = nextGame.status === "waiting" && connectedPlayers < 2;
      const rematchVotes = {
        player1: toBoolean((networkState as AnyRecord).player1Rematch, false),
        player2: toBoolean((networkState as AnyRecord).player2Rematch, false),
      };
      const countdownActive =
        nextGame.status === "waiting" &&
        connectedPlayers === 2 &&
        countdownEndsAtMs > Date.now() &&
        countdownDurationMs > 0;
      const matchingPredictedRuntime = currentStore.online.ownSnakeId
        ? findMatchingPredictedRuntime(tick, nextGame, currentStore.online.ownSnakeId)
        : null;

      onlineAuthoritativeState = nextGame;
      onlineAuthoritativeTick = tick;
      onlineNextTickAtMs = nextTickAtMs;
      onlineAuthoritativeProcessedInputs = processedInputs;
      onlineAuthoritativeRngSeed = rngSeed;
      pruneAcknowledgedPendingInputs(currentStore.online.ownSnakeId, processedInputs);

      if (matchingPredictedRuntime && previousDisplayTick >= tick) {
        const preservedRuntime =
          onlinePredictionRuntime && onlinePredictionRuntime.tick >= tick
            ? onlinePredictionRuntime
            : matchingPredictedRuntime;

        onlinePredictionRuntime = preservedRuntime;
        prunePredictedHistory(tick);
        onlineLastCorrectionDistance = 0;

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
            session: toSessionSummary(networkState),
            countdown: countdownActive
              ? createCountdownState({
                  active: true,
                  endsAtMs: countdownEndsAtMs,
                  durationMs: countdownDurationMs,
                  source: "online",
                })
              : createCountdownState(),
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
              authoritativeTick: tick,
              displayTick: state.online.displayTick,
              network: getOnlineNetworkSnapshot(ownId, state.online.displayTick, tick),
            }),
          };
        });

        if (nextGame.status === "running") {
          scheduleOnlinePredictionStep(
            setState,
            computeOnlinePredictionDelayMs(nextGame.config.tickRateMs, preservedRuntime.tick),
          );
        } else {
          stopOnlinePredictionLoop();
        }
        return;
      }

      const rebuiltRuntime = rebuildOnlinePredictionRuntime(currentStore.online.ownSnakeId);
      const runtime =
        rebuiltRuntime ??
        createRuntimeFromGameState(nextGame, {
          tick,
          processedInputSequences: processedInputs,
          rngSeed,
        });
      const displayGame = mergeControlledSnake(nextGame, runtime.game, currentStore.online.ownSnakeId);

      onlinePredictionRuntime = runtime;
      resetPredictedHistory(runtime);

      const correctionActive =
        Boolean(currentStore.online.ownSnakeId) && previousDisplayTick >= tick;
      const correctionDistance =
        currentStore.online.ownSnakeId && correctionActive
          ? estimateSnakeHeadCorrection(previousGame, displayGame, currentStore.online.ownSnakeId)
          : 0;

      onlineLastCorrectionDistance = correctionDistance;
      if (correctionDistance > 0 && correctionActive) {
        onlineCorrectionCount += 1;
      }

      const transition = computeTransition(
        previousGame,
        displayGame,
        runtime.tick,
        tickEvent,
        computeAuthoritativeTransitionDurationMs(
          nextGame.config.tickRateMs,
          nextGame.status,
          correctionActive,
          correctionDistance,
        ),
      );

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
          gameState: displayGame,
          transition,
          renderVersion: state.renderVersion + 1,
          session: toSessionSummary(networkState),
          countdown: countdownActive
            ? createCountdownState({
                active: true,
                endsAtMs: countdownEndsAtMs,
                durationMs: countdownDurationMs,
                source: "online",
              })
            : createCountdownState(),
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
            authoritativeTick: tick,
            displayTick: runtime.tick,
            network: getOnlineNetworkSnapshot(ownId, runtime.tick, tick),
          }),
        };
      });
      scheduleTransitionClear(setState, transition);

      if (nextGame.status === "running") {
        scheduleOnlinePredictionStep(
          setState,
          computeOnlinePredictionDelayMs(nextGame.config.tickRateMs, runtime.tick),
        );
      } else {
        stopOnlinePredictionLoop();
      }
    });

    room.onLeave((code, reason) => {
      if (generation !== matchmakingGeneration) {
        return;
      }

      onlineRoom = null;
      resetOnlineRuntimeState();
      clearTransitionTimer();
      setState((state) => ({
        ...state,
        mode: "menu",
        gameState: engine.reset("waiting"),
        transition: null,
        session: createSessionSummary(),
        countdown: createCountdownState(),
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
      resetOnlineRuntimeState();
      clearTransitionTimer();
      setState((state) => ({
        ...state,
        mode: "menu",
        gameState: engine.reset("waiting"),
        transition: null,
        session: createSessionSummary(),
        countdown: createCountdownState(),
        online: createOnlineSessionState({
          ...state.online,
          connecting: false,
          lastError: `Erreur réseau (${code})${message ? `: ${message}` : ""}`,
        }),
        renderVersion: state.renderVersion + 1,
      }));
    });

    startOnlinePingLoop();
  } catch (error) {
    if (generation !== matchmakingGeneration) {
      return;
    }

    const message = error instanceof Error ? error.message : "Connexion matchmaking impossible.";
    resetOnlineRuntimeState();
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
    countdown: createCountdownState(),
    startLocalGame: () => {
      resetLocalManualTimeControl();
      matchmakingGeneration += 1;
      stopOnlineRoom(true);
      resetOnlineRuntimeState();
      clearTransitionTimer();
      clearRoundCountdownTimer();
      const countdownEndsAtMs = Date.now() + ROUND_START_COUNTDOWN_MS;
      const next = engine.reset("waiting");
      set((state) => ({
        ...state,
        mode: "local",
        gameState: next,
        transition: null,
        session: createNewSession(),
        countdown: createCountdownState({
          active: true,
          endsAtMs: countdownEndsAtMs,
          durationMs: ROUND_START_COUNTDOWN_MS,
          source: "local",
        }),
        online: createOnlineSessionState(),
        renderVersion: state.renderVersion + 1,
      }));
      roundCountdownTimeoutHandle = window.setTimeout(() => {
        activateLocalRound(set);
      }, ROUND_START_COUNTDOWN_MS);
    },
    restartLocalGame: () => {
      resetLocalManualTimeControl();
      clearTransitionTimer();
      clearRoundCountdownTimer();
      const countdownEndsAtMs = Date.now() + ROUND_START_COUNTDOWN_MS;
      const next = engine.reset("waiting");
      set((state) => ({
        ...state,
        mode: "local",
        gameState: next,
        transition: null,
        session: advanceSessionRound(state.session),
        countdown: createCountdownState({
          active: true,
          endsAtMs: countdownEndsAtMs,
          durationMs: ROUND_START_COUNTDOWN_MS,
          source: "local",
        }),
        renderVersion: state.renderVersion + 1,
      }));
      roundCountdownTimeoutHandle = window.setTimeout(() => {
        activateLocalRound(set);
      }, ROUND_START_COUNTDOWN_MS);
    },
    startOnlineMatchmaking: () => {
      void startOnlineMatchmaking(set);
    },
    cancelMatchmaking: () => {
      resetLocalManualTimeControl();
      matchmakingGeneration += 1;
      stopOnlineRoom(true);
      resetOnlineRuntimeState();
      clearTransitionTimer();
      clearRoundCountdownTimer();
      const waiting = engine.reset("waiting");
      set((state) => ({
        ...state,
        mode: "menu",
        gameState: waiting,
        transition: null,
        session: createSessionSummary(),
        countdown: createCountdownState(),
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
      resetOnlineRuntimeState();
      clearTransitionTimer();
      clearRoundCountdownTimer();
      const waiting = engine.reset("waiting");
      set((state) => ({
        ...state,
        mode: "menu",
        gameState: waiting,
        transition: null,
        session: createSessionSummary(),
        countdown: createCountdownState(),
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
      const ownSnakeId = state.online.ownSnakeId;
      if (
        state.mode !== "online" ||
        state.gameState.status !== "running" ||
        !onlineRoom ||
        !ownSnakeId
      ) {
        return false;
      }

      const sequence = onlineNextInputSequence;
      const baseRuntime =
        onlinePredictionRuntime ??
        rebuildOnlinePredictionRuntime(ownSnakeId) ??
        (onlineAuthoritativeState
          ? createRuntimeFromGameState(onlineAuthoritativeState, {
              tick: onlineAuthoritativeTick,
              processedInputSequences: onlineAuthoritativeProcessedInputs,
              rngSeed: onlineAuthoritativeRngSeed,
            })
          : null);

      if (!baseRuntime) {
        return false;
      }

      const result = queueInput(
        baseRuntime,
        ownSnakeId,
        { direction, sequence },
        { maxBufferSize: ONLINE_INPUT_BUFFER_SIZE },
      );

      if (!result.accepted) {
        return false;
      }

      onlinePredictionRuntime = result.runtime;
      onlinePendingInputs = [...onlinePendingInputs, { sequence, direction }];
      onlineNextInputSequence += 1;
      onlineRoom.send("input", { direction, sequence });

      set((store) => ({
        ...store,
        online: createOnlineSessionState({
          ...store.online,
          network: getOnlineNetworkSnapshot(
            store.online.ownSnakeId,
            store.online.displayTick,
            store.online.authoritativeTick,
          ),
        }),
      }));

      if (onlinePredictionTimeoutHandle === null) {
        scheduleOnlinePredictionStep(
          set,
          computeOnlinePredictionDelayMs(
            state.gameState.config.tickRateMs,
            onlinePredictionRuntime?.tick ?? onlineAuthoritativeTick,
          ),
        );
      }
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
  resetOnlineRuntimeState();
  clearTransitionTimer();
  clearRoundCountdownTimer();
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
      authoritativeTick: state.online.authoritativeTick,
      displayTick: state.online.displayTick,
      network: state.online.network,
    },
    transition: state.transition
      ? {
          tick: state.transition.tick,
          durationMs: state.transition.durationMs,
          fatalCollision: state.transition.fatalCollision,
        }
      : null,
    countdown: state.countdown,
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
  window.enqueueInput = (direction: Direction, snakeId?: SnakeId) => {
    const state = useLocalGameStore.getState();
    if (state.mode === "online") {
      return state.enqueueOnlineInput(direction);
    }

    const resolvedSnakeId = snakeId ?? "player1";
    return state.enqueueLocalInput(resolvedSnakeId, direction);
  };
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

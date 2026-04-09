import type { GameState, GridPosition, SnakeState } from "@snake-duel/shared";
import Phaser from "phaser";
import {
  getOnlineAuthoritativeState,
  getOnlineRenderTimingSnapshot,
  type RemoteRenderDebugSnapshot,
  useLocalGameStore,
} from "../localGameStore.js";
import {
  mergeControlledSnake,
  resolveRemoteSmoothingDurationMs,
} from "../localGameStore.helpers.js";
import { FOOD_PARTICLE_TEXTURE, GRID_HEIGHT, GRID_WIDTH } from "./constants.js";
import {
  computeArenaBoardLayout,
  getBoardSegmentSize,
  toBoardPosition,
  type ArenaBoardLayout,
} from "./boardLayout.js";
import {
  alignWorldPosition,
  interpolateAlignedGridMotion,
  interpolateTimedWorld,
  resolveWrappedWorld,
  type WorldPoint,
} from "./segmentMotion.js";

type SegmentNode = Phaser.GameObjects.Rectangle;

interface TimedSegmentMotion {
  readonly kind: "timed";
  currentWorld: WorldPoint;
  startWorld: WorldPoint;
  targetWorld: WorldPoint;
  startedAtMs: number;
  durationMs: number;
}

interface RemoteSnapshot {
  readonly tick: number;
  readonly perfMs: number;
  readonly state: GameState;
}

interface RemoteSegmentMeta {
  readonly snakeId: SnakeState["id"];
  readonly index: number;
}

interface RemoteSegmentSample {
  readonly world: WorldPoint;
  readonly targetWorld: WorldPoint;
  readonly durationMs: number;
}

interface RemoteSnakeSample {
  readonly segments: readonly (RemoteSegmentSample | null)[];
}

type SnakeArenaGlobal = typeof globalThis & {
  __SNAKE_DUEL_RENDER_DEBUG__?: RemoteRenderDebugSnapshot;
};

const REMOTE_TARGET_SETTLE_EPSILON_PX = 0.12;
const REMOTE_MAX_COAST_RATIO = 0.14;
const REMOTE_SNAPSHOT_LIMIT = 6;

const PALETTE = {
  board: 0x0b1220,
  boardBorder: 0x1f2937,
  gridLine: 0x233041,
  player1: 0x2dd4bf,
  player1Head: 0x5eead4,
  player2: 0xfb923c,
  player2Head: 0xfdba74,
  dead: 0x4b5563,
  food: 0xf59e0b,
} as const;

function createRemoteRenderDebugSnapshot(): RemoteRenderDebugSnapshot {
  return {
    headFrames: 0,
    headMovingFrames: 0,
    headSettledFrames: 0,
    currentHeadX: null,
    currentHeadY: null,
    targetHeadX: null,
    targetHeadY: null,
    headTargetDistancePx: 0,
    maxHeadTargetDistancePx: 0,
    motionDurationMs: 0,
  };
}

function writeRemoteRenderDebugSnapshot(snapshot: RemoteRenderDebugSnapshot | null): void {
  const globalObject = globalThis as SnakeArenaGlobal;

  if (snapshot === null) {
    delete globalObject.__SNAKE_DUEL_RENDER_DEBUG__;
    return;
  }

  globalObject.__SNAKE_DUEL_RENDER_DEBUG__ = snapshot;
}

export class SnakeArenaScene extends Phaser.Scene {
  private readonly segments = new Map<string, SegmentNode>();
  private readonly wrapGhosts = new Map<string, SegmentNode>();
  private readonly segmentMotion = new Map<string, TimedSegmentMotion>();
  private readonly remoteSegmentMeta = new Map<string, RemoteSegmentMeta>();
  private remoteSnapshots: RemoteSnapshot[] = [];
  private remoteRenderDebug = createRemoteRenderDebugSnapshot();
  private boardGraphics: Phaser.GameObjects.Graphics | null = null;
  private foodNode: Phaser.GameObjects.Arc | null = null;
  private foodPulseTween: Phaser.Tweens.Tween | null = null;
  private layout: ArenaBoardLayout | null = null;
  private renderVersion = -1;
  private authoritativeRenderTick = -1;
  private snapNextRender = false;

  public constructor() {
    super({ key: "SnakeArenaScene" });
  }

  public create(): void {
    this.boardGraphics = this.add.graphics().setDepth(0);
    this.remoteRenderDebug = createRemoteRenderDebugSnapshot();
    writeRemoteRenderDebugSnapshot(this.remoteRenderDebug);
    this.ensureParticleTexture();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.handleShutdown, this);
    this.handleResize();
  }

  public override update(): void {
    this.renderFromStore(false);
    this.advanceSegmentMotion(performance.now());
  }

  private handleResize(): void {
    this.layout = computeArenaBoardLayout({
      width: this.scale.width,
      height: this.scale.height,
    });
    this.drawBoardBackground();
    this.snapNextRender = true;
    this.renderFromStore(true);
  }

  private handleShutdown(): void {
    this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.foodPulseTween?.stop();
    this.foodPulseTween = null;
    this.boardGraphics = null;
    this.layout = null;
    this.renderVersion = -1;
    this.authoritativeRenderTick = -1;

    for (const node of this.wrapGhosts.values()) {
      node.destroy();
    }
    this.wrapGhosts.clear();
    this.segmentMotion.clear();
    this.remoteSegmentMeta.clear();
    this.remoteSnapshots = [];
    this.remoteRenderDebug = createRemoteRenderDebugSnapshot();
    writeRemoteRenderDebugSnapshot(null);
  }

  private renderFromStore(force: boolean): void {
    const layout = this.layout;
    if (!layout) {
      return;
    }

    const storeState = useLocalGameStore.getState();
    const ownSnakeId = storeState.mode === "online" ? storeState.online.ownSnakeId : null;
    const authoritativeState =
      storeState.mode === "online" ? getOnlineAuthoritativeState() : null;
    const authoritativeTick =
      storeState.mode === "online" ? storeState.online.authoritativeTick : -1;
    const authoritativeTickChanged =
      storeState.mode === "online" && authoritativeTick !== this.authoritativeRenderTick;

    if (storeState.mode !== "online") {
      this.authoritativeRenderTick = -1;
      this.resetRemoteSnapshots();
    } else if (authoritativeState) {
      if (force || authoritativeTickChanged || this.remoteSnapshots.length === 0) {
        this.pushRemoteSnapshot(
          authoritativeState,
          authoritativeTick,
          storeState.online.authoritativeTickPerfMs ?? performance.now(),
        );
      }
    } else {
      this.resetRemoteSnapshots();
    }

    if (!force && !authoritativeTickChanged && storeState.renderVersion === this.renderVersion) {
      return;
    }

    this.renderVersion = storeState.renderVersion;
    this.authoritativeRenderTick = authoritativeTick;
    const state =
      storeState.mode === "online" && authoritativeState
        ? mergeControlledSnake(authoritativeState, storeState.gameState, ownSnakeId)
        : storeState.gameState;
    const transition = storeState.transition;
    const previous = transition?.previous;
    const transitionDurationMs = Math.max(1, transition?.durationMs ?? state.config.tickRateMs);
    const nowMs = performance.now();
    const snapPositions =
      force ||
      this.snapNextRender ||
      !previous ||
      previous.status !== state.status ||
      state.status !== "running";

    this.syncFood(state, previous, layout, snapPositions);
    this.syncSnakes(
      state,
      previous,
      layout,
      snapPositions,
      transitionDurationMs,
      ownSnakeId,
      nowMs,
    );
    this.snapNextRender = false;

    if (!force && transition?.foodEatenAt) {
      this.playEatBurst(transition.foodEatenAt);
    }
    if (!force && transition?.fatalCollision) {
      this.time.delayedCall(transitionDurationMs, () => {
        this.cameras.main.shake(200, 0.01);
      });
    }
  }

  private drawBoardBackground(): void {
    if (!this.boardGraphics || !this.layout) {
      return;
    }

    const graphics = this.boardGraphics;
    const layout = this.layout;
    const borderOffset = layout.borderWidth % 2 === 1 ? 0.5 : 0;
    const gridOffset = layout.gridLineWidth % 2 === 1 ? 0.5 : 0;

    graphics.clear();
    graphics.fillStyle(PALETTE.board, 1);
    graphics.fillRoundedRect(
      layout.offsetX,
      layout.offsetY,
      layout.boardWidth,
      layout.boardHeight,
      layout.borderRadius,
    );
    graphics.lineStyle(layout.borderWidth, PALETTE.boardBorder, 0.9);
    graphics.strokeRoundedRect(
      layout.offsetX + borderOffset,
      layout.offsetY + borderOffset,
      layout.boardWidth - borderOffset * 2,
      layout.boardHeight - borderOffset * 2,
      layout.borderRadius,
    );
    graphics.lineStyle(layout.gridLineWidth, PALETTE.gridLine, 0.35);
    for (let x = 1; x < GRID_WIDTH; x += 1) {
      const lineX = layout.offsetX + x * layout.cellSize + gridOffset;
      graphics.lineBetween(lineX, layout.offsetY, lineX, layout.offsetY + layout.boardHeight);
    }
    for (let y = 1; y < GRID_HEIGHT; y += 1) {
      const lineY = layout.offsetY + y * layout.cellSize + gridOffset;
      graphics.lineBetween(layout.offsetX, lineY, layout.offsetX + layout.boardWidth, lineY);
    }
  }

  private syncFood(
    state: GameState,
    previous: GameState | undefined,
    layout: ArenaBoardLayout,
    snapPositions: boolean,
  ): void {
    const food = state.food;
    if (!food) {
      this.foodNode?.destroy();
      this.foodNode = null;
      this.foodPulseTween?.stop();
      this.foodPulseTween = null;
      return;
    }

    const target = toBoardPosition(layout, food);
    if (!this.foodNode) {
      this.foodNode = this.add
        .circle(target.x, target.y, layout.foodRadius, PALETTE.food)
        .setDepth(12);
      this.startFoodPulse();
      return;
    }

    this.foodNode.setRadius(layout.foodRadius);
    const previousFood = previous?.food;
    const moved = Boolean(previousFood && (previousFood.x !== food.x || previousFood.y !== food.y));
    if (snapPositions || moved) {
      this.foodNode.setPosition(target.x, target.y);
      this.startFoodPulse();
    } else {
      this.foodNode.setPosition(target.x, target.y);
    }
  }

  private syncSnakes(
    state: GameState,
    previous: GameState | undefined,
    layout: ArenaBoardLayout,
    snapPositions: boolean,
    transitionDurationMs: number,
    ownSnakeId: SnakeState["id"] | null,
    nowMs: number,
  ): void {
    const previousById = new Map(previous?.snakes.map((snake) => [snake.id, snake]) ?? []);
    const activeKeys = new Set<string>();
    const activeGhostKeys = new Set<string>();

    for (const snake of state.snakes) {
      const previousSnake = previousById.get(snake.id);
      for (let index = 0; index < snake.body.length; index += 1) {
        const segment = snake.body[index];
        if (!segment) {
          continue;
        }

        const key = `${snake.id}-${index}`;
        activeKeys.add(key);

        const visualAlive = didSnakeDieThisTick(previousSnake, snake) ? true : snake.alive;
        const node = this.ensureSegmentNode(key, snake, index, visualAlive, layout);
        const ghostKey = `${key}::wrap`;
        const ghost = this.ensureWrapGhostNode(ghostKey, snake, index, visualAlive, layout);
        activeGhostKeys.add(ghostKey);
        const remoteSnake = ownSnakeId !== null && snake.id !== ownSnakeId;

        if (remoteSnake) {
          this.remoteSegmentMeta.set(key, { snakeId: snake.id, index });
          this.segmentMotion.delete(key);
          this.renderSegmentWorld(node, ghost, layout, toBoardPosition(layout, segment));
          continue;
        }

        this.remoteSegmentMeta.delete(key);
        const targetWorld = toBoardPosition(layout, segment);
        const from = previousSnake?.body[index];
        const motion = this.segmentMotion.get(key);

        if (snapPositions || !from || !motion) {
          const snappedWorld = { ...targetWorld };
          this.segmentMotion.set(key, {
            kind: "timed",
            currentWorld: snappedWorld,
            startWorld: snappedWorld,
            targetWorld: snappedWorld,
            startedAtMs: nowMs,
            durationMs: 0,
          });
          this.renderSegmentWorld(node, ghost, layout, snappedWorld);
          continue;
        }

        if (areSameGridPosition(from, segment)) {
          const snappedWorld = { ...targetWorld };
          this.segmentMotion.set(key, {
            kind: "timed",
            currentWorld: snappedWorld,
            startWorld: snappedWorld,
            targetWorld: snappedWorld,
            startedAtMs: nowMs,
            durationMs: 0,
          });
          this.renderSegmentWorld(node, ghost, layout, snappedWorld);
          continue;
        }

        const currentWorld = this.resolveTimedMotionWorld(motion, nowMs);
        const alignedTarget = alignWorldPosition(layout, currentWorld, segment);
        this.segmentMotion.set(key, {
          kind: "timed",
          currentWorld,
          startWorld: currentWorld,
          targetWorld: alignedTarget,
          startedAtMs: nowMs,
          durationMs: transitionDurationMs,
        });
      }
    }

    for (const [key, node] of this.segments) {
      if (activeKeys.has(key)) {
        continue;
      }
      node.destroy();
      this.segments.delete(key);
      this.segmentMotion.delete(key);
      this.remoteSegmentMeta.delete(key);
    }

    for (const [key, node] of this.wrapGhosts) {
      if (activeGhostKeys.has(key)) {
        continue;
      }
      node.destroy();
      this.wrapGhosts.delete(key);
    }
  }

  private ensureSegmentNode(
    key: string,
    snake: SnakeState,
    index: number,
    visualAlive: boolean,
    layout: ArenaBoardLayout,
  ): SegmentNode {
    const existing = this.segments.get(key);
    const alpha = visualAlive ? 1 : 0.72;
    const size = getBoardSegmentSize(layout, index);
    const color = getSnakeColor(snake, index, visualAlive);
    if (existing) {
      existing
        .setSize(size, size)
        .setDisplaySize(size, size)
        .setFillStyle(color)
        .setAlpha(alpha);
      return existing;
    }

    const node = this.add.rectangle(0, 0, size, size, color).setDepth(10);
    node.setAlpha(alpha);
    this.segments.set(key, node);
    return node;
  }

  private ensureWrapGhostNode(
    key: string,
    snake: SnakeState,
    index: number,
    visualAlive: boolean,
    layout: ArenaBoardLayout,
  ): SegmentNode {
    const existing = this.wrapGhosts.get(key);
    const alpha = visualAlive ? 1 : 0.72;
    const size = getBoardSegmentSize(layout, index);
    const color = getSnakeColor(snake, index, visualAlive);
    if (existing) {
      existing
        .setVisible(true)
        .setSize(size, size)
        .setDisplaySize(size, size)
        .setFillStyle(color)
        .setAlpha(alpha);
      return existing;
    }

    const node = this.add.rectangle(0, 0, size, size, color).setDepth(10);
    node.setAlpha(alpha);
    this.wrapGhosts.set(key, node);
    return node;
  }

  private advanceSegmentMotion(nowMs: number): void {
    const layout = this.layout;
    if (!layout) {
      return;
    }

    const remoteSnakeSamples = new Map<SnakeState["id"], RemoteSnakeSample | null>();

    for (const [key, motion] of this.segmentMotion) {
      const node = this.segments.get(key);
      const ghost = this.wrapGhosts.get(`${key}::wrap`);
      if (!node || !ghost) {
        continue;
      }

      const world = this.resolveTimedMotionWorld(motion, nowMs);
      motion.currentWorld = world;
      this.renderSegmentWorld(node, ghost, layout, world);
    }

    for (const [key, meta] of this.remoteSegmentMeta) {
      const node = this.segments.get(key);
      const ghost = this.wrapGhosts.get(`${key}::wrap`);
      if (!node || !ghost) {
        continue;
      }

      let snakeSample = remoteSnakeSamples.get(meta.snakeId);
      if (snakeSample === undefined) {
        snakeSample = this.sampleRemoteSnake(layout, meta.snakeId, nowMs);
        remoteSnakeSamples.set(meta.snakeId, snakeSample);
      }

      const sample = snakeSample?.segments[meta.index] ?? null;
      if (!sample) {
        continue;
      }

      if (meta.index === 0) {
        this.recordRemoteHeadRenderSample(sample);
      }

      this.renderSegmentWorld(node, ghost, layout, sample.world);
    }
  }

  private resolveRemoteInterpolationDelayMs(tickRateMs: number): number {
    const renderTiming = getOnlineRenderTimingSnapshot();
    return resolveRemoteSmoothingDurationMs({
      tickRateMs,
      jitterMs: renderTiming.jitterMs,
      authoritativeIntervalMs: renderTiming.authoritativeIntervalMs,
      authoritativeJitterMs: renderTiming.authoritativeJitterMs,
    });
  }

  private resolveTimedMotionWorld(motion: TimedSegmentMotion, nowMs: number): WorldPoint {
    return interpolateTimedWorld(
      motion.startWorld,
      motion.targetWorld,
      nowMs - motion.startedAtMs,
      motion.durationMs,
    );
  }

  private pushRemoteSnapshot(state: GameState, tick: number, perfMs: number): void {
    const snapshot: RemoteSnapshot = {
      tick: Math.max(0, tick),
      perfMs: Number.isFinite(perfMs) ? perfMs : performance.now(),
      state: cloneGameState(state),
    };
    const previous = this.remoteSnapshots.at(-1) ?? null;

    if (
      previous &&
      (snapshot.tick <= previous.tick ||
        previous.state.status !== snapshot.state.status ||
        previous.state.config.tickRateMs !== snapshot.state.config.tickRateMs)
    ) {
      this.remoteSnapshots = [snapshot];
      return;
    }

    this.remoteSnapshots = [...this.remoteSnapshots, snapshot].slice(-REMOTE_SNAPSHOT_LIMIT);
  }

  private resetRemoteSnapshots(): void {
    if (
      this.remoteSnapshots.length === 0 &&
      this.remoteSegmentMeta.size === 0 &&
      this.remoteRenderDebug.headFrames === 0
    ) {
      return;
    }

    this.remoteSnapshots = [];
    this.remoteSegmentMeta.clear();
    this.remoteRenderDebug = createRemoteRenderDebugSnapshot();
    writeRemoteRenderDebugSnapshot(this.remoteRenderDebug);
  }

  private sampleRemoteSnake(
    layout: ArenaBoardLayout,
    snakeId: SnakeState["id"],
    nowMs: number,
  ): RemoteSnakeSample | null {
    const snapshots = this.remoteSnapshots;
    if (snapshots.length === 0) {
      return null;
    }

    const newest = snapshots.at(-1) ?? null;
    if (!newest) {
      return null;
    }

    const renderAtMs = nowMs - this.resolveRemoteInterpolationDelayMs(newest.state.config.tickRateMs);
    const oldest = snapshots[0] ?? newest;

    if (snapshots.length === 1 || renderAtMs <= oldest.perfMs) {
      const snake = findSnapshotSnake(oldest.state, snakeId);
      if (!snake) {
        return null;
      }
      return {
        segments: snake.body.map((segment) => {
          const world = toBoardPosition(layout, segment);
          return {
            world,
            targetWorld: world,
            durationMs: Math.max(1, oldest.state.config.tickRateMs),
          };
        }),
      };
    }

    let previous = oldest;
    let next: RemoteSnapshot | null = null;
    for (let snapshotIndex = 1; snapshotIndex < snapshots.length; snapshotIndex += 1) {
      const candidate = snapshots[snapshotIndex];
      if (!candidate) {
        continue;
      }
      if (candidate.perfMs >= renderAtMs) {
        next = candidate;
        break;
      }
      previous = candidate;
    }

    if (!next) {
      const latestSnake = findSnapshotSnake(newest.state, snakeId);
      if (!latestSnake) {
        return null;
      }
      const priorSnapshot = snapshots.at(-2) ?? null;
      const priorSnake = priorSnapshot ? findSnapshotSnake(priorSnapshot.state, snakeId) : null;
      const durationMs = priorSnapshot
        ? Math.max(1, newest.perfMs - priorSnapshot.perfMs)
        : Math.max(1, newest.state.config.tickRateMs);
      const coastRatio = priorSnapshot
        ? Math.min(
            REMOTE_MAX_COAST_RATIO,
            Math.max(0, renderAtMs - newest.perfMs) / durationMs,
          )
        : 0;

      return {
        segments: latestSnake.body.map((segment, segmentIndex) => {
          const previousSegment = priorSnake?.body[segmentIndex] ?? null;
          if (!previousSegment || coastRatio <= 0) {
            const world = toBoardPosition(layout, segment);
            return {
              world,
              targetWorld: world,
              durationMs,
            };
          }

          const motion = interpolateAlignedGridMotion(
            layout,
            previousSegment,
            segment,
            durationMs,
            durationMs,
          );
          const startWorld = toBoardPosition(layout, previousSegment);
          const world = {
            x: motion.targetWorld.x + (motion.targetWorld.x - startWorld.x) * coastRatio,
            y: motion.targetWorld.y + (motion.targetWorld.y - startWorld.y) * coastRatio,
          };

          return {
            world,
            targetWorld: motion.targetWorld,
            durationMs,
          };
        }),
      };
    }

    const previousSnake = findSnapshotSnake(previous.state, snakeId);
    const nextSnake = findSnapshotSnake(next.state, snakeId);
    if (!previousSnake && !nextSnake) {
      return null;
    }

    const durationMs = Math.max(1, next.perfMs - previous.perfMs);
    const elapsedMs = Math.max(0, Math.min(durationMs, renderAtMs - previous.perfMs));
    const segmentCount = Math.max(previousSnake?.body.length ?? 0, nextSnake?.body.length ?? 0);
    const segments: (RemoteSegmentSample | null)[] = [];
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      const fromPosition = previousSnake?.body[segmentIndex] ?? null;
      const toPosition = nextSnake?.body[segmentIndex] ?? null;
      const resolvedFrom = fromPosition ?? toPosition;
      const resolvedTo = toPosition ?? fromPosition;
      if (!resolvedFrom || !resolvedTo) {
        segments.push(null);
        continue;
      }

      const motion = interpolateAlignedGridMotion(
        layout,
        resolvedFrom,
        resolvedTo,
        elapsedMs,
        durationMs,
      );
      segments.push({
        world: motion.world,
        targetWorld: motion.targetWorld,
        durationMs,
      });
    }

    return {
      segments,
    };
  }

  private recordRemoteHeadRenderSample(sample: RemoteSegmentSample): void {
    const headTargetDistancePx = measureWorldDistance(sample.world, sample.targetWorld);
    this.remoteRenderDebug = {
      headFrames: this.remoteRenderDebug.headFrames + 1,
      headMovingFrames:
        this.remoteRenderDebug.headMovingFrames +
        (headTargetDistancePx > REMOTE_TARGET_SETTLE_EPSILON_PX ? 1 : 0),
      headSettledFrames:
        this.remoteRenderDebug.headSettledFrames +
        (headTargetDistancePx <= REMOTE_TARGET_SETTLE_EPSILON_PX ? 1 : 0),
      currentHeadX: roundMetric(sample.world.x),
      currentHeadY: roundMetric(sample.world.y),
      targetHeadX: roundMetric(sample.targetWorld.x),
      targetHeadY: roundMetric(sample.targetWorld.y),
      headTargetDistancePx: roundMetric(headTargetDistancePx),
      maxHeadTargetDistancePx: Math.max(
        this.remoteRenderDebug.maxHeadTargetDistancePx,
        roundMetric(headTargetDistancePx),
      ),
      motionDurationMs: Math.round(sample.durationMs),
    };
    writeRemoteRenderDebugSnapshot(this.remoteRenderDebug);
  }

  private renderSegmentWorld(
    node: SegmentNode,
    ghost: SegmentNode,
    layout: ArenaBoardLayout,
    world: WorldPoint,
  ): void {
    const wrapped = resolveWrappedWorld(layout, world);
    node.setPosition(wrapped.primary.x, wrapped.primary.y);

    if (wrapped.ghost) {
      ghost.setVisible(true);
      ghost.setPosition(wrapped.ghost.x, wrapped.ghost.y);
      return;
    }

    ghost.setVisible(false);
  }

  private startFoodPulse(): void {
    if (!this.foodNode) {
      return;
    }
    this.foodPulseTween?.stop();
    this.foodNode.setScale(1);
    this.foodPulseTween = this.tweens.add({
      targets: this.foodNode,
      scale: { from: 0.86, to: 1.14 },
      duration: 380,
      ease: "Sine.easeInOut",
      yoyo: true,
      repeat: -1,
    });
  }

  private ensureParticleTexture(): void {
    if (this.textures.exists(FOOD_PARTICLE_TEXTURE)) {
      return;
    }
    const painter = this.add.graphics();
    painter.fillStyle(0xffffff, 1);
    painter.fillCircle(4, 4, 4);
    painter.generateTexture(FOOD_PARTICLE_TEXTURE, 8, 8);
    painter.destroy();
  }

  private playEatBurst(cell: GridPosition): void {
    const layout = this.layout;
    if (!layout) {
      return;
    }

    const world = toBoardPosition(layout, cell);
    const emitter = this.add
      .particles(world.x, world.y, FOOD_PARTICLE_TEXTURE, {
        emitting: false,
        lifespan: 260,
        speed: { min: layout.cellSize * 0.9, max: layout.cellSize * 5.6 },
        scale: { start: 0.65, end: 0 },
        quantity: 18,
        angle: { min: 0, max: 360 },
        tint: [0xfcd34d, 0xf59e0b, 0xfbbf24],
        blendMode: "ADD",
      })
      .setDepth(14);

    // The emitter is already positioned on the consumed cell.
    // Passing x/y again to explode would offset particles a second time.
    emitter.explode(18);
    this.time.delayedCall(360, () => emitter.destroy());
  }
}

function getSnakeColor(snake: SnakeState, index: number, alive: boolean): number {
  if (!alive) {
    return PALETTE.dead;
  }
  if (snake.id === "player1") {
    return index === 0 ? PALETTE.player1Head : PALETTE.player1;
  }
  return index === 0 ? PALETTE.player2Head : PALETTE.player2;
}

function didSnakeDieThisTick(previous: SnakeState | undefined, next: SnakeState): boolean {
  return Boolean(previous?.alive && !next.alive);
}

function areSameGridPosition(a: GridPosition, b: GridPosition): boolean {
  return a.x === b.x && a.y === b.y;
}

function measureWorldDistance(from: WorldPoint, to: WorldPoint): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function cloneGameState(state: GameState): GameState {
  return {
    ...state,
    config: { ...state.config },
    food: state.food ? { ...state.food } : null,
    snakes: state.snakes.map(cloneSnakeState),
  };
}

function cloneSnakeState(snake: SnakeState): SnakeState {
  return {
    ...snake,
    body: snake.body.map((segment) => ({ ...segment })),
  };
}

function findSnapshotSnake(
  state: GameState,
  snakeId: SnakeState["id"],
): SnakeState | null {
  const snake = state.snakes.find((candidate) => candidate.id === snakeId);
  return snake ? cloneSnakeState(snake) : null;
}

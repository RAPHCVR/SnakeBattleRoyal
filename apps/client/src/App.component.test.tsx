// @vitest-environment jsdom

import "./test/setup-component.js";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_GAME_CONFIG, type GameState, type SnakeState } from "@snake-duel/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  controls: {
    coarsePointer: false,
    orientation: "portrait" as "portrait" | "landscape",
    fullscreen: {
      supported: false,
      active: false,
      toggle: vi.fn(async () => false),
    },
  },
  destroyLocalGameLoop: vi.fn(),
  keyboardControls: vi.fn(),
  storeState: null as Record<string, unknown> | null,
}));

vi.mock("framer-motion", async () => {
  const React = await import("react");

  return {
    AnimatePresence: ({ children }: { readonly children: React.ReactNode }) => <>{children}</>,
    motion: new Proxy(
      {},
      {
        get: (_target, tag) =>
          ({ children, ...props }: { readonly children?: React.ReactNode } & Record<string, unknown>) =>
            React.createElement(tag as string, props, children as React.ReactNode),
      },
    ),
  };
});

vi.mock("./game/localGameStore.js", () => ({
  destroyLocalGameLoop: mocks.destroyLocalGameLoop,
  useLocalGameStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(mocks.storeState ?? {}),
}));

vi.mock("./hooks/useInputControls.js", () => ({
  useKeyboardControls: mocks.keyboardControls,
  useIsCoarsePointer: () => mocks.controls.coarsePointer,
  useViewportOrientation: () => mocks.controls.orientation,
  useFullscreenSession: () => mocks.controls.fullscreen,
}));

vi.mock("./components/PhaserViewport.js", () => ({
  PhaserViewport: () => <div data-testid="phaser-viewport" />,
}));

vi.mock("./components/TouchControlsDock.js", () => ({
  TouchControlsDock: ({
    mode,
    floating,
    onToggleFullscreen,
  }: {
    readonly mode: string;
    readonly floating?: boolean;
    readonly onToggleFullscreen?: () => void;
  }) => (
    <div data-testid="touch-controls-dock">
      dock:{mode}:{floating ? "floating" : "inline"}
      {onToggleFullscreen ? (
        <button type="button" onClick={onToggleFullscreen}>
          Plein ecran
        </button>
      ) : null}
    </div>
  ),
  LandscapeSplitControls: () => <div data-testid="touch-controls-landscape">landscape</div>,
}));

import { App } from "./App.js";

describe("App component states", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.controls.coarsePointer = false;
    mocks.controls.orientation = "portrait";
    mocks.controls.fullscreen.supported = false;
    mocks.controls.fullscreen.active = false;
    mocks.controls.fullscreen.toggle.mockClear();
    mocks.destroyLocalGameLoop.mockClear();
    mocks.keyboardControls.mockClear();
    mocks.storeState = createStoreState();
  });

  it("renders touch controls during a local pre-round countdown on touch devices", async () => {
    mocks.controls.coarsePointer = true;
    mocks.storeState = createStoreState({
      mode: "local",
      gameState: createGameState("waiting"),
      countdown: {
        active: true,
        endsAtMs: Date.now() + 3_000,
        durationMs: 3_000,
        source: "local",
      },
    });

    render(<App />);

    expect(await screen.findByTestId("touch-controls-dock")).toHaveTextContent("dock:local:floating");
    expect(screen.getByText("Chargement du rendu Phaser...")).toBeInTheDocument();
  });

  it("keeps the portrait fullscreen fallback on the compact floating dock", async () => {
    mocks.controls.coarsePointer = true;
    mocks.controls.orientation = "portrait";
    mocks.storeState = createStoreState({
      mode: "local",
      gameState: createGameState("running"),
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Plein ecran" }));

    await waitFor(() => expect(mocks.controls.fullscreen.toggle).toHaveBeenCalledTimes(1));
    expect(mocks.controls.fullscreen.toggle).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ orientation: "landscape" }),
    );
    await waitFor(() => expect(screen.getByTestId("touch-controls-dock")).toHaveTextContent("dock:local:floating"));
    expect(screen.queryByTestId("touch-controls-landscape")).not.toBeInTheDocument();
  });

  it("hides touch controls after local game over while keeping the end screen visible", () => {
    mocks.controls.coarsePointer = true;
    mocks.storeState = createStoreState({
      mode: "local",
      gameState: createGameState("game_over", { winner: "draw" }),
    });

    render(<App />);

    expect(screen.queryByTestId("touch-controls-dock")).not.toBeInTheDocument();
    expect(screen.getByText("Game Over")).toBeInTheDocument();
    expect(screen.getByText("Match nul")).toBeInTheDocument();
  });

  it("shows the waiting overlay while keeping touch controls available for fullscreen actions", () => {
    mocks.controls.coarsePointer = true;
    mocks.storeState = createStoreState({
      mode: "online",
      gameState: createGameState("waiting"),
      online: {
        connectedPlayers: 1,
        ownSnakeId: "player1",
        roomId: "ABCD",
        roomStatus: "waiting",
        waitingForOpponent: true,
      },
    });

    render(<App />);

    expect(screen.getByTestId("touch-controls-dock")).toHaveTextContent("dock:online:inline");
    expect(screen.getAllByText("Room en attente")).not.toHaveLength(0);
    expect(screen.getByText(/En attente d'un adversaire/i)).toBeInTheDocument();
  });

  it("keeps online fullscreen in the inline portrait layout", async () => {
    mocks.controls.coarsePointer = true;
    mocks.storeState = createStoreState({
      mode: "online",
      gameState: createGameState("waiting"),
      online: {
        connectedPlayers: 1,
        ownSnakeId: "player1",
        roomId: "ABCD",
        roomStatus: "waiting",
        waitingForOpponent: true,
      },
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Plein ecran" }));

    await waitFor(() => expect(mocks.controls.fullscreen.toggle).toHaveBeenCalledTimes(1));
    expect(mocks.controls.fullscreen.toggle).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ orientation: "portrait" }),
    );
    expect(screen.getByTestId("touch-controls-dock")).toHaveTextContent("dock:online:inline");
    expect(screen.queryByTestId("touch-controls-landscape")).not.toBeInTheDocument();
  });

  it("hides raw network telemetry during stable online play", () => {
    mocks.storeState = createStoreState({
      mode: "online",
      gameState: createGameState("running"),
      online: {
        ownSnakeId: "player1",
        roomId: "ABCD",
        roomStatus: "running",
        network: {
          latencyMs: 38,
          jitterMs: 7,
          quality: "excellent",
          pendingInputs: 1,
          lastSentSequence: 4,
          lastProcessedSequence: 3,
          correctionCount: 0,
          lastCorrectionDistance: 0,
          predictionLeadTicks: 1,
        },
      },
    });

    render(<App />);

    expect(screen.queryByText("Ping 38ms")).not.toBeInTheDocument();
    expect(screen.queryByText("Jitter 7ms")).not.toBeInTheDocument();
    expect(screen.queryByText("Sync fragile")).not.toBeInTheDocument();
    expect(screen.getByText("PLAYER1")).toBeInTheDocument();
  });

  it("surfaces connection warnings only when telemetry is actually degraded", () => {
    mocks.storeState = createStoreState({
      mode: "online",
      gameState: createGameState("running"),
      online: {
        ownSnakeId: "player1",
        roomId: "ABCD",
        roomStatus: "running",
        network: {
          latencyMs: 122,
          jitterMs: 24,
          quality: "fair",
          pendingInputs: 0,
          lastSentSequence: 8,
          lastProcessedSequence: 8,
          correctionCount: 1,
          lastCorrectionDistance: 0,
          predictionLeadTicks: 0,
        },
      },
    });

    render(<App />);

    expect(screen.getByText("Connexion fragile")).toBeInTheDocument();
  });

  it("keeps the touch status chip short when online sync is degraded", () => {
    mocks.controls.coarsePointer = true;
    mocks.storeState = createStoreState({
      mode: "online",
      gameState: createGameState("running"),
      session: {
        roundNumber: 4,
        player1Wins: 1,
        player2Wins: 1,
      },
      online: {
        ownSnakeId: "player1",
        roomId: "ABCD",
        roomStatus: "running",
        network: {
          latencyMs: 126,
          jitterMs: 26,
          quality: "fair",
          pendingInputs: 0,
          lastSentSequence: 8,
          lastProcessedSequence: 8,
          correctionCount: 2,
          lastCorrectionDistance: 0,
          predictionLeadTicks: 0,
        },
      },
    });

    render(<App />);

    expect(screen.getByText("P1 Sync")).toBeInTheDocument();
    expect(screen.queryByText("Connexion fragile")).not.toBeInTheDocument();
  });

  it("shows a countdown overlay before the round starts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T12:00:00Z"));

    mocks.storeState = createStoreState({
      mode: "local",
      gameState: createGameState("waiting"),
      session: {
        roundNumber: 4,
        player1Wins: 2,
        player2Wins: 1,
      },
      countdown: {
        active: true,
        endsAtMs: Date.now() + 3_000,
        durationMs: 3_000,
        source: "local",
      },
    });

    render(<App />);

    expect(screen.getAllByText("Manche 4")).not.toHaveLength(0);
    expect(screen.getAllByText("3")).not.toHaveLength(0);

    vi.useRealTimers();
  });
});

function createStoreState(
  overrides: Partial<{
    mode: string;
    gameState: GameState;
    session: {
      roundNumber: number;
      player1Wins: number;
      player2Wins: number;
    };
    online: Partial<Record<string, unknown>>;
    countdown: {
      active: boolean;
      endsAtMs: number | null;
      durationMs: number;
      source: "none" | "local" | "online";
    };
  }> = {},
): Record<string, unknown> {
  return {
    mode: overrides.mode ?? "menu",
    gameState: overrides.gameState ?? createGameState("waiting"),
    transition: null,
    session:
      overrides.session ?? {
        roundNumber: 0,
        player1Wins: 0,
        player2Wins: 0,
      },
    online: {
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
      network: {
        latencyMs: null,
        jitterMs: null,
        quality: "unknown",
        pendingInputs: 0,
        lastSentSequence: 0,
        lastProcessedSequence: 0,
        correctionCount: 0,
        lastCorrectionDistance: 0,
        predictionLeadTicks: 0,
      },
      ...(overrides.online ?? {}),
    },
    countdown:
      overrides.countdown ?? {
        active: false,
        endsAtMs: null,
        durationMs: 0,
        source: "none",
      },
    startLocalGame: vi.fn(),
    restartLocalGame: vi.fn(),
    startOnlineMatchmaking: vi.fn(),
    cancelMatchmaking: vi.fn(),
    voteRematch: vi.fn(),
    returnToMenu: vi.fn(),
    togglePause: vi.fn(),
  };
}

function createGameState(
  status: GameState["status"],
  overrides: Partial<GameState> = {},
): GameState {
  return {
    status,
    config: DEFAULT_GAME_CONFIG,
    snakes: [createSnake("player1"), createSnake("player2")],
    food: { x: 10, y: 10 },
    winner: null,
    ...overrides,
  };
}

function createSnake(id: SnakeState["id"]): SnakeState {
  if (id === "player1") {
    return {
      id,
      body: [
        { x: 2, y: 10 },
        { x: 1, y: 10 },
        { x: 0, y: 10 },
      ],
      direction: "right",
      alive: true,
      score: 0,
    };
  }

  return {
    id,
    body: [
      { x: 17, y: 10 },
      { x: 18, y: 10 },
      { x: 19, y: 10 },
    ],
    direction: "left",
    alive: true,
    score: 0,
  };
}

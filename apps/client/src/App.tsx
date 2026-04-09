import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { destroyLocalGameLoop, useLocalGameStore } from "./game/localGameStore.js";
import { MenuArenaPreview } from "./components/MenuArenaPreview.js";
import { LandscapeSplitControls, TouchControlsDock } from "./components/TouchControlsDock.js";
import {
  useFullscreenSession,
  useIsCoarsePointer,
  useKeyboardControls,
  useViewportOrientation,
} from "./hooks/useInputControls.js";

let phaserViewportPromise:
  | Promise<{ default: typeof import("./components/PhaserViewport.js").PhaserViewport }>
  | null = null;

function loadPhaserViewport() {
  phaserViewportPromise ??= import("./components/PhaserViewport.js").then((module) => ({
    default: module.PhaserViewport,
  }));
  return phaserViewportPromise;
}

const PhaserViewport = lazy(loadPhaserViewport);

export function App() {
  const shellRef = useRef<HTMLElement | null>(null);
  const [localFocusMode, setLocalFocusMode] = useState(false);

  useKeyboardControls();
  useEffect(() => () => destroyLocalGameLoop(), []);

  const mode = useLocalGameStore((state) => state.mode);
  const gameState = useLocalGameStore((state) => state.gameState);
  const transition = useLocalGameStore((state) => state.transition);
  const session = useLocalGameStore((state) => state.session);
  const online = useLocalGameStore((state) => state.online);
  const countdown = useLocalGameStore((state) => state.countdown);

  const startLocalGame = useLocalGameStore((state) => state.startLocalGame);
  const restartLocalGame = useLocalGameStore((state) => state.restartLocalGame);
  const startOnlineMatchmaking = useLocalGameStore((state) => state.startOnlineMatchmaking);
  const cancelMatchmaking = useLocalGameStore((state) => state.cancelMatchmaking);
  const voteRematch = useLocalGameStore((state) => state.voteRematch);
  const returnToMenu = useLocalGameStore((state) => state.returnToMenu);
  const togglePause = useLocalGameStore((state) => state.togglePause);

  const coarsePointer = useIsCoarsePointer();
  const orientation = useViewportOrientation();
  const fullscreen = useFullscreenSession();
  const countdownDisplay = useCountdownDisplay(countdown);

  const player1 = gameState.snakes.find((snake) => snake.id === "player1");
  const player2 = gameState.snakes.find((snake) => snake.id === "player2");

  const isMenu = mode === "menu";
  const isMatchmaking = mode === "matchmaking";
  const isLocal = mode === "local";
  const isOnline = mode === "online";
  const paused = isLocal && gameState.status === "paused";
  const canPauseLocal = isLocal && (gameState.status === "running" || gameState.status === "paused");
  const showGameOver =
    (isLocal || isOnline) &&
    gameState.status === "game_over" &&
    !transition?.fatalCollision;
  const showOnlineWaiting =
    isOnline &&
    online.waitingForOpponent &&
    gameState.status === "waiting" &&
    !countdown.active;
  const showCountdownOverlay =
    countdown.active &&
    !isMatchmaking &&
    !showOnlineWaiting &&
    (isLocal || isOnline);
  const touchMode = coarsePointer ? (isLocal ? "local" : isOnline ? "online" : null) : null;
  const touchLocalFocusMode = touchMode === "local" && localFocusMode;
  const touchLocalImmersiveMode = touchMode === "local" && (fullscreen.active || touchLocalFocusMode);
  const touchFocusMode = touchLocalImmersiveMode;
  const touchSideImmersiveMode = touchMode === "local" && touchLocalImmersiveMode;
  const splitTouchLocal = touchMode === "local" && orientation === "landscape";
  const showTouchControls =
    Boolean(touchMode) && !isMenu && !isMatchmaking && gameState.status !== "game_over";
  const desktopGameMode = !isMenu && !touchMode;
  const immersiveDesktopMode = desktopGameMode && fullscreen.active;
  const shouldRenderPhaser = !isMenu;
  const floatingTouchLocal = touchMode === "local" && !splitTouchLocal;
  const mobileMenu = coarsePointer && isMenu;
  const showHeader = isMenu && !mobileMenu;
  const showDesktopArenaHud = desktopGameMode;
  const showTouchArenaHud = Boolean(touchMode) && !isMenu && !splitTouchLocal && !touchFocusMode;
  const shouldLockBodyScroll = Boolean(touchMode) || immersiveDesktopMode;
  const arenaSizeClass =
    touchFocusMode
      ? "h-full min-h-0"
      : splitTouchLocal
        ? "h-[min(68svh,18rem)] min-h-[12.5rem] sm:h-[min(72svh,20rem)]"
        : floatingTouchLocal
          ? "h-[min(50svh,19rem)] min-h-[14rem] sm:h-[min(52svh,20rem)]"
          : touchMode === "online"
            ? "h-[min(47svh,18rem)] min-h-[13rem] sm:h-[min(49svh,19rem)]"
            : desktopGameMode
              ? "flex-1 min-h-0"
                : mobileMenu
                  ? "h-[min(50svh,18rem)] min-h-[17rem]"
                  : "h-[min(62vh,32rem)] min-h-[360px] xl:h-[min(66vh,38rem)]";
  const desktopInnerClass = desktopGameMode
    ? `${immersiveDesktopMode ? "max-w-none h-[calc(100svh-1rem)] gap-2" : "max-w-[72rem] h-[calc(100svh-1.5rem)] gap-3"} min-h-0`
    : null;
  const desktopHudClass = immersiveDesktopMode
    ? "glass-panel arena-hud arena-hud--desktop-immersive"
    : "glass-panel arena-hud";
  const desktopSectionPaddingClass = immersiveDesktopMode ? "p-1.5 sm:p-2" : "p-2.5 sm:p-3";
  const constrainedSquareMax = desktopGameMode && !immersiveDesktopMode ? 42 * 16 : null;
  const roundLabel = session.roundNumber > 0 ? `Manche ${session.roundNumber}` : null;
  const sessionScoreLabel = `${session.player1Wins} - ${session.player2Wins}`;
  const onlineSeatLabel = isOnline && online.ownSnakeId ? online.ownSnakeId.toUpperCase() : null;
  const touchSeatLabel =
    isOnline && online.ownSnakeId ? (online.ownSnakeId === "player1" ? "P1" : "P2") : "Online";
  const connectionWarning = isOnline ? toConnectionWarning(online.network) : null;
  const touchConnectionWarning = isOnline ? toCompactConnectionWarning(online.network) : null;
  const phaseLabel = isMenu
    ? "Menu"
    : isMatchmaking
      ? "Matchmaking"
      : isOnline
        ? showOnlineWaiting
          ? "Room"
          : "Online"
        : isLocal
          ? "Local"
          : "Arena";
  const headerTitle = "Snake Duel Arena";
  const headerSubtitle = "Duel local instantane ou room online autoritaire, avec rendu Phaser et inputs buffers.";
  const controlsLabel =
    splitTouchLocal
      ? "Paysage mobile: un pad par joueur."
      : touchMode === "local"
        ? "Touches locales tactiles."
        : touchMode === "online"
          ? "Touches online tactiles."
          : toControlLabel(mode);
  const desktopStatusChip = showCountdownOverlay
    ? `Depart ${countdownDisplay.shortLabel}`
    : showOnlineWaiting
      ? `En attente ${Math.min(online.connectedPlayers, 2)}/2`
      : paused
        ? "Pause"
        : connectionWarning;
  const touchSummaryLabel = showOnlineWaiting
    ? `Room ${Math.min(online.connectedPlayers, 2)}/2`
    : showCountdownOverlay
      ? `T-${countdownDisplay.shortLabel}`
      : paused
        ? "Pause"
        : isOnline
          ? touchConnectionWarning
            ? `${touchSeatLabel} ${touchConnectionWarning}`
            : touchSeatLabel
          : "Ready";
  const touchSummaryAccent =
    showOnlineWaiting || paused || touchConnectionWarning ? "orange" : isOnline ? "teal" : "slate";
  const touchFullscreenEnabled = Boolean(touchMode);

  const handleToggleFullscreen = () => {
    void fullscreen.toggle(shellRef.current);
  };
  const handleToggleTouchFullscreen = async () => {
    if (touchMode === "local") {
      if (fullscreen.active) {
        await fullscreen.toggle(shellRef.current, { orientation: "landscape" });
        return;
      }

      if (touchLocalFocusMode) {
        setLocalFocusMode(false);
        return;
      }

      const entered = await fullscreen.toggle(shellRef.current, { orientation: "landscape" });
      if (!entered) {
        setLocalFocusMode(true);
      }
      return;
    }

    if (touchMode === "online") {
      if (fullscreen.active) {
        await fullscreen.toggle(shellRef.current, { orientation: "portrait" });
        return;
      }

      await fullscreen.toggle(shellRef.current, { orientation: "portrait" });
      return;
    }

    await fullscreen.toggle(shellRef.current);
  };

  useEffect(() => {
    if (!shouldLockBodyScroll) {
      document.documentElement.style.removeProperty("overflow");
      document.body.style.removeProperty("overflow");
      return;
    }

    window.scrollTo({ top: 0, behavior: "instant" });
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";

    return () => {
      document.documentElement.style.removeProperty("overflow");
      document.body.style.removeProperty("overflow");
    };
  }, [shouldLockBodyScroll]);

  useEffect(() => {
    if (!coarsePointer || mode !== "local") {
      setLocalFocusMode(false);
    }
  }, [coarsePointer, mode]);

  useEffect(() => {
    if (!fullscreen.active) {
      return;
    }

    if (touchLocalFocusMode) {
      setLocalFocusMode(false);
    }

  }, [fullscreen.active, touchLocalFocusMode]);

  const primePhaserViewport = () => {
    void loadPhaserViewport();
  };

  const handleStartLocalGame = () => {
    primePhaserViewport();
    startLocalGame();
  };

  const handleStartOnlineMatchmaking = () => {
    primePhaserViewport();
    startOnlineMatchmaking();
  };

  return (
    <main
      ref={shellRef}
      className={`app-shell relative overflow-x-hidden text-slate-100 ${
        immersiveDesktopMode
          ? "px-2 py-2 sm:px-3"
          : desktopGameMode
            ? "px-4 py-3 sm:px-5 lg:px-6"
            : splitTouchLocal
              ? "px-4 pb-4 sm:px-6 sm:pb-5 lg:px-8"
              : "px-4 py-5 sm:px-6 sm:py-6 lg:px-8"
      } ${
        splitTouchLocal
          ? `app-shell--touch-side${touchSideImmersiveMode ? " app-shell--touch-side-immersive" : ""}`
          : desktopGameMode
            ? "app-shell--desktop-game"
            : touchMode === "local"
              ? "app-shell--touch-local"
              : touchMode === "online"
                ? "app-shell--touch-online"
                : ""
      } ${touchFocusMode ? "app-shell--touch-immersive" : ""} ${
        floatingTouchLocal ? "app-shell--floating-local-dock" : ""
      }`}
    >
      <div
        className={`mx-auto flex w-full flex-col ${
          touchFocusMode
            ? "h-full max-w-none gap-3"
            : desktopGameMode
              ? desktopInnerClass
                : splitTouchLocal
                  ? "max-w-6xl gap-2 sm:gap-3"
                  : "gap-5"
        }`}
      >
        {showHeader ? (
          <header className="glass-panel flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <div>
              <p className="text-[10px] uppercase tracking-[0.32em] text-cyan-200/70">
                Snake Duel Arena
              </p>
              <h1 className="mt-1 text-2xl font-black tracking-tight sm:text-3xl">
                {headerTitle}
              </h1>
              <p className="mt-1 max-w-2xl text-xs text-slate-300 sm:text-sm">
                {headerSubtitle}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <InfoChip label="Wrap arena" accent="teal" />
                <InfoChip label="Buffer x3" />
                <InfoChip label="Clavier + tactile" accent="orange" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs sm:text-sm">
              <StatCard
                title="Local"
                value="Instantane"
                detail="2 joueurs, meme ecran"
                accent="teal"
              />
              <StatCard
                title="Online"
                value="Room sync"
                detail="Matchmaking et rematch"
                accent="orange"
              />
            </div>
          </header>
        ) : null}

        {showDesktopArenaHud ? (
          <div data-arena-hud="desktop" className={desktopHudClass}>
            <div className="arena-hud__stack">
              <div className="arena-hud__cluster">
                <InfoChip
                  label={phaseLabel}
                  accent={isOnline ? "orange" : "teal"}
                  compact
                  className={immersiveDesktopMode ? "arena-chip--immersive" : undefined}
                />
                {roundLabel ? <InfoChip label={roundLabel} compact /> : null}
                <InfoChip label={`Session ${sessionScoreLabel}`} compact />
                {onlineSeatLabel ? <InfoChip label={onlineSeatLabel} compact /> : null}
                {desktopStatusChip ? (
                  <InfoChip
                    label={desktopStatusChip}
                    accent="orange"
                    compact
                    className={immersiveDesktopMode ? "arena-chip--immersive" : undefined}
                  />
                ) : null}
              </div>
            </div>

            <div className="arena-hud__stack arena-hud__stack--end">
              <div className="arena-hud__scores">
                <CompactArenaScore
                  title="J1"
                  value={`${session.player1Wins}M • ${player1?.score ?? 0} pts`}
                  accent="teal"
                  compact={immersiveDesktopMode}
                />
                <CompactArenaScore
                  title="J2"
                  value={`${session.player2Wins}M • ${player2?.score ?? 0} pts`}
                  accent="orange"
                  compact={immersiveDesktopMode}
                />
              </div>
              <div className="arena-hud__cluster arena-hud__cluster--actions">
                {canPauseLocal ? (
                  <ToolbarButton onClick={togglePause} compact={immersiveDesktopMode}>
                    {paused ? "Reprendre" : "Pause"}
                  </ToolbarButton>
                ) : null}
                {fullscreen.supported ? (
                  <ToolbarButton onClick={handleToggleFullscreen} compact={immersiveDesktopMode}>
                    {fullscreen.active ? "Quitter plein ecran" : "Plein ecran"}
                  </ToolbarButton>
                ) : null}
                <ToolbarButton onClick={returnToMenu} compact={immersiveDesktopMode}>
                  {isOnline ? "Quitter" : "Menu"}
                </ToolbarButton>
              </div>
            </div>
          </div>
        ) : null}

        {showTouchArenaHud ? (
          <div data-arena-hud="touch" className="glass-panel arena-hud arena-hud--touch">
            <div className="arena-hud__stack">
              <div className="arena-hud__cluster">
                <InfoChip label={phaseLabel} accent={isOnline ? "orange" : "teal"} compact />
                {roundLabel ? <InfoChip label={roundLabel} compact /> : null}
                <InfoChip
                  label={touchSummaryLabel}
                  accent={touchSummaryAccent}
                  compact
                  className="arena-chip--touch-status"
                  dataAttribute="touch-status"
                />
              </div>
              <div className="arena-hud__scores arena-hud__scores--touch">
                <CompactArenaScore
                  title="J1"
                  value={`${session.player1Wins}M • ${player1?.score ?? 0} pts`}
                  accent="teal"
                />
                <CompactArenaScore
                  title="J2"
                  value={`${session.player2Wins}M • ${player2?.score ?? 0} pts`}
                  accent="orange"
                />
              </div>
            </div>
          </div>
        ) : null}

        <section
          className={`glass-panel relative overflow-hidden ${
            touchFocusMode
              ? "flex-1 min-h-0 p-1.5 sm:p-2"
              : desktopGameMode
                ? desktopSectionPaddingClass
                : splitTouchLocal
                  ? "p-2 sm:p-3"
                  : "p-3 sm:p-4"
          } ${arenaSizeClass}`}
        >
          <div className="relative h-full w-full overflow-hidden rounded-[1.35rem] border border-slate-700/60 bg-[#020611]/78">
            <SquareArenaFrame
              enabled={desktopGameMode || Boolean(touchMode)}
              maxSquareSize={constrainedSquareMax}
            >
              {shouldRenderPhaser ? (
                <Suspense
                  fallback={
                    <div className="flex h-full w-full items-center justify-center text-sm text-slate-300">
                      Chargement du rendu Phaser...
                    </div>
                  }
                >
                  <PhaserViewport />
                </Suspense>
              ) : (
                <MenuArenaPreview />
              )}
            </SquareArenaFrame>

            {isMenu ? (
              <motion.div
                key="menu"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.12, ease: "easeOut" }}
                className="overlay-panel"
              >
                <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Duel pret</h2>
                <p className="mt-2 max-w-md text-center text-sm text-slate-300">
                  Joue en local instantane ou en ligne via Colyseus matchmaking.
                </p>
                <div className="mt-6 flex flex-wrap justify-center gap-3">
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handleStartLocalGame}
                    onPointerEnter={primePhaserViewport}
                    onFocus={primePhaserViewport}
                  >
                    Jouer en Local
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleStartOnlineMatchmaking}
                    onPointerEnter={primePhaserViewport}
                    onFocus={primePhaserViewport}
                  >
                    Jouer en Ligne
                  </button>
                </div>
                <p className="mt-4 text-center text-xs text-slate-400">{controlsLabel}</p>
                {online.lastError ? (
                  <p className="mt-3 text-center text-xs text-rose-300">{online.lastError}</p>
                ) : null}
              </motion.div>
            ) : null}

            <AnimatePresence>
              {isMatchmaking ? (
                <motion.div
                  key="matchmaking"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12, ease: "easeOut" }}
                  className="overlay-subpanel"
                >
                  <div className="loader-orbit" />
                  <p className="mt-4 text-xs uppercase tracking-[0.28em] text-slate-300">
                    Matchmaking
                  </p>
                  <p className="mt-1 text-center text-sm text-slate-300">
                    Recherche d&apos;un adversaire...
                  </p>
                  <button type="button" className="btn-secondary mt-5" onClick={cancelMatchmaking}>
                    Annuler
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <AnimatePresence>
              {showOnlineWaiting ? (
                <motion.div
                  key="online-waiting"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12, ease: "easeOut" }}
                  className="overlay-subpanel"
                >
                  <div className="loader-orbit" />
                  <p className="mt-4 text-xs uppercase tracking-[0.28em] text-slate-300">
                    Room en attente
                  </p>
                  <p className="mt-1 text-center text-sm text-slate-300">
                    En attente d&apos;un adversaire...
                  </p>
                  <p className="mt-2 max-w-sm text-center text-xs text-slate-400">
                    Le duel demarre automatiquement des qu&apos;un deuxieme joueur rejoint la room.
                  </p>
                  <button type="button" className="btn-secondary mt-5" onClick={returnToMenu}>
                    Quitter la room
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <AnimatePresence>
              {showCountdownOverlay ? (
                <motion.div
                  key="countdown"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12, ease: "easeOut" }}
                  className="overlay-subpanel"
                >
                  <p className="text-xs uppercase tracking-[0.28em] text-slate-300">
                    {roundLabel ?? "Nouvelle manche"}
                  </p>
                  <div className="countdown-ring">
                    <span className="countdown-ring__digit">{countdownDisplay.shortLabel}</span>
                  </div>
                  <p className="mt-4 text-center text-sm text-slate-200">
                    {isOnline
                      ? "Synchronisation des deux joueurs avant le depart."
                      : "Preparez les deux serpents avant le coup d&apos;envoi."}
                  </p>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <AnimatePresence>
              {paused ? (
                <motion.div
                  key="paused"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12, ease: "easeOut" }}
                  className="overlay-subpanel"
                >
                  <p className="text-sm uppercase tracking-[0.25em] text-slate-300">Pause</p>
                  <button type="button" className="btn-primary mt-4" onClick={togglePause}>
                    Reprendre
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <AnimatePresence>
              {showGameOver ? (
                <motion.div
                  key="game-over"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12, ease: "easeOut" }}
                  className="overlay-subpanel"
                >
                  <p className="text-xs uppercase tracking-[0.25em] text-slate-300">Game Over</p>
                  <h3 className="mt-2 text-2xl font-black tracking-tight">
                    {toWinnerLabel(gameState.winner)}
                  </h3>
                  <p className="mt-2 text-center text-xs text-slate-300">
                    {roundLabel ? `${roundLabel} terminee` : "Manche terminee"} • Session {sessionScoreLabel}
                  </p>

                  <div className="mt-5 flex flex-wrap justify-center gap-3">
                    {isLocal ? (
                      <button type="button" className="btn-primary" onClick={restartLocalGame}>
                        Manche suivante
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={voteRematch}
                        disabled={online.rematchVoted}
                      >
                        {online.rematchVoted ? "Vote envoye" : "Voter manche suivante"}
                      </button>
                    )}

                    <button type="button" className="btn-secondary" onClick={returnToMenu}>
                      Menu
                    </button>
                  </div>

                  {isOnline && online.waitingOpponentRematch ? (
                    <p className="mt-3 text-xs text-cyan-200">En attente du vote adverse...</p>
                  ) : null}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </section>

        <AnimatePresence>
          {showTouchControls && splitTouchLocal ? (
            <LandscapeSplitControls
              player1Score={player1?.score ?? 0}
              player1Length={player1?.body.length ?? 0}
              player2Score={player2?.score ?? 0}
              player2Length={player2?.body.length ?? 0}
              paused={paused}
              showPauseAction={canPauseLocal}
              onTogglePause={togglePause}
              fullscreenSupported
              fullscreenActive={touchLocalImmersiveMode}
              immersive={touchSideImmersiveMode}
              onToggleFullscreen={handleToggleTouchFullscreen}
            />
          ) : showTouchControls && touchMode ? (
            <TouchControlsDock
              mode={touchMode}
              floating={floatingTouchLocal}
              compact={floatingTouchLocal}
              suggestLandscape={touchMode === "local"}
              fullscreenSupported={touchFullscreenEnabled}
              fullscreenActive={fullscreen.active}
              onToggleFullscreen={handleToggleTouchFullscreen}
              {...(touchMode === "local" && canPauseLocal
                ? {
                    primaryActionLabel: paused ? "Reprendre" : "Pause",
                    onPrimaryAction: togglePause,
                  }
                : {})}
              {...(touchMode === "online"
                ? { secondaryActionLabel: "Quitter", onSecondaryAction: returnToMenu }
                : {})}
            />
          ) : null}
        </AnimatePresence>
      </div>
    </main>
  );
}

interface InfoChipProps {
  readonly label: string;
  readonly accent?: "teal" | "orange" | "slate";
  readonly compact?: boolean;
  readonly className?: string | undefined;
  readonly dataAttribute?: string | undefined;
}

function InfoChip({
  label,
  accent = "slate",
  compact = false,
  className,
  dataAttribute,
}: InfoChipProps) {
  const palette =
    accent === "teal"
      ? "border-cyan-400/25 bg-cyan-400/10 text-cyan-50"
      : accent === "orange"
        ? "border-orange-400/28 bg-orange-400/10 text-orange-50"
        : "border-slate-500/40 bg-slate-800/60 text-slate-200";

  return (
    <span
      data-touch-status-chip={dataAttribute === "touch-status" ? "true" : undefined}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-3 py-1 font-semibold uppercase leading-none tracking-[0.18em] ${palette} ${
        compact ? "text-[9px]" : "text-[10px]"
      } ${className ?? ""}`}
    >
      {label}
    </span>
  );
}

interface ToolbarButtonProps {
  readonly children: string;
  readonly onClick: () => void;
  readonly compact?: boolean;
}

function ToolbarButton({ children, onClick, compact = false }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={`rounded-full border border-slate-500/40 bg-slate-950/78 font-semibold text-slate-100 transition hover:border-cyan-300/40 hover:bg-slate-900/85 ${
        compact ? "min-h-[2rem] px-2.5 py-1.5 text-[10px]" : "min-h-[2.45rem] px-3 py-2 text-[11px]"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface CompactArenaScoreProps {
  readonly title: string;
  readonly value: string;
  readonly accent: "teal" | "orange";
  readonly compact?: boolean;
}

function CompactArenaScore({ title, value, accent, compact = false }: CompactArenaScoreProps) {
  return (
    <div className={`arena-score-pill arena-score-pill--${accent} ${compact ? "arena-score-pill--compact" : ""}`}>
      <span className="arena-score-pill__title">{title}</span>
      <span className="arena-score-pill__value">{value}</span>
    </div>
  );
}

interface SquareArenaFrameProps {
  readonly enabled: boolean;
  readonly children: ReactNode;
  readonly maxSquareSize?: number | null;
}

function SquareArenaFrame({
  enabled,
  children,
  maxSquareSize = null,
}: SquareArenaFrameProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [squareSize, setSquareSize] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!enabled) {
      setSquareSize(null);
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    let frameHandle = 0;
    const syncSquareSize = () => {
      frameHandle = 0;
      const measuredSize = Math.max(1, Math.floor(Math.min(container.clientWidth, container.clientHeight)));
      const nextSize = maxSquareSize ? Math.min(measuredSize, maxSquareSize) : measuredSize;
      setSquareSize((current) => (current === nextSize ? current : nextSize));
    };
    const queueResize = () => {
      if (frameHandle) {
        window.cancelAnimationFrame(frameHandle);
      }
      frameHandle = window.requestAnimationFrame(syncSquareSize);
    };

    const resizeObserver = new ResizeObserver(() => queueResize());
    const visualViewport = window.visualViewport ?? null;

    resizeObserver.observe(container);
    window.addEventListener("resize", queueResize);
    window.addEventListener("orientationchange", queueResize);
    visualViewport?.addEventListener("resize", queueResize);
    document.addEventListener("fullscreenchange", queueResize);
    document.addEventListener("webkitfullscreenchange", queueResize as EventListener);
    syncSquareSize();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", queueResize);
      window.removeEventListener("orientationchange", queueResize);
      visualViewport?.removeEventListener("resize", queueResize);
      document.removeEventListener("fullscreenchange", queueResize);
      document.removeEventListener("webkitfullscreenchange", queueResize as EventListener);
      if (frameHandle) {
        window.cancelAnimationFrame(frameHandle);
      }
    };
  }, [enabled, maxSquareSize]);

  return (
    <div ref={containerRef} className={`h-full w-full ${enabled ? "grid place-items-center" : ""}`}>
      <div
        className={enabled ? "max-h-full max-w-full" : "h-full w-full"}
        style={
          enabled
            ? squareSize
              ? { width: `${squareSize}px`, height: `${squareSize}px` }
              : { width: "0px", height: "0px" }
            : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}

interface StatCardProps {
  readonly title: string;
  readonly value: string;
  readonly detail: string;
  readonly accent: "teal" | "orange";
}

function StatCard({ title, value, detail, accent }: StatCardProps) {
  return (
    <div
      className={`rounded-xl border px-3 py-2 ${
        accent === "teal"
          ? "border-teal-400/40 bg-teal-400/10"
          : "border-orange-400/40 bg-orange-400/10"
      }`}
    >
      <p className="text-[10px] uppercase tracking-[0.16em] text-slate-300">{title}</p>
      <p className="mt-1 text-base font-bold">{value}</p>
      <p className="text-[11px] text-slate-300">{detail}</p>
    </div>
  );
}

function toWinnerLabel(winner: "player1" | "player2" | "draw" | null): string {
  if (winner === "player1") {
    return "Victoire Player 1";
  }
  if (winner === "player2") {
    return "Victoire Player 2";
  }
  if (winner === "draw") {
    return "Match nul";
  }
  return "Partie terminee";
}

function toControlLabel(mode: string): string {
  if (mode === "local") {
    return "Clavier local: WASD (J1), fleches (J2), espace (pause).";
  }
  if (mode === "online") {
    return "Clavier online: WASD ou fleches pour votre serpent.";
  }
  if (mode === "matchmaking") {
    return "Connexion en cours au matchmaking Colyseus.";
  }
  return "Choisissez un mode puis lancez la partie.";
}

function toConnectionWarning(network: {
  readonly quality: "unknown" | "excellent" | "good" | "fair" | "poor";
  readonly pendingInputs: number;
  readonly lastCorrectionDistance: number;
}): string | null {
  if (network.pendingInputs >= 2) {
    return "File d'inputs chargee";
  }

  if (network.lastCorrectionDistance > 1) {
    return "Resynchronisation";
  }

  if (network.quality === "fair" || network.quality === "poor") {
    return "Connexion fragile";
  }

  return null;
}

function toCompactConnectionWarning(network: {
  readonly quality: "unknown" | "excellent" | "good" | "fair" | "poor";
  readonly pendingInputs: number;
  readonly lastCorrectionDistance: number;
}): string | null {
  if (network.pendingInputs >= 2) {
    return "Queue";
  }

  if (network.lastCorrectionDistance > 1) {
    return "Resync";
  }

  if (network.quality === "fair" || network.quality === "poor") {
    return "Sync";
  }

  return null;
}

interface CountdownStateShape {
  readonly active: boolean;
  readonly endsAtMs: number | null;
}

function useCountdownDisplay(countdown: CountdownStateShape): {
  readonly shortLabel: string;
} {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!countdown.active || !countdown.endsAtMs) {
      return;
    }

    setNow(Date.now());
    const handle = window.setInterval(() => {
      setNow(Date.now());
    }, 100);

    return () => {
      window.clearInterval(handle);
    };
  }, [countdown.active, countdown.endsAtMs]);

  if (!countdown.active || !countdown.endsAtMs) {
    return { shortLabel: "0" };
  }

  const remainingMs = countdown.endsAtMs - now;
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  return {
    shortLabel: remainingSeconds > 0 ? String(remainingSeconds) : "GO",
  };
}

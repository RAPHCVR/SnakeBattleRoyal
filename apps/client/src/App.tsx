import { lazy, Suspense, useEffect, useRef, useState } from "react";
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
  const [onlineFocusMode, setOnlineFocusMode] = useState(false);

  useKeyboardControls();
  useEffect(() => () => destroyLocalGameLoop(), []);

  const mode = useLocalGameStore((state) => state.mode);
  const gameState = useLocalGameStore((state) => state.gameState);
  const transition = useLocalGameStore((state) => state.transition);
  const session = useLocalGameStore((state) => state.session);
  const online = useLocalGameStore((state) => state.online);

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

  const player1 = gameState.snakes.find((snake) => snake.id === "player1");
  const player2 = gameState.snakes.find((snake) => snake.id === "player2");

  const isMenu = mode === "menu";
  const isMatchmaking = mode === "matchmaking";
  const isLocal = mode === "local";
  const isOnline = mode === "online";
  const canPauseLocal = isLocal && gameState.status !== "game_over";
  const paused = isLocal && gameState.status === "paused";
  const showGameOver =
    (isLocal || isOnline) &&
    gameState.status === "game_over" &&
    !transition?.fatalCollision;
  const showOnlineWaiting = isOnline && online.waitingForOpponent && gameState.status === "waiting";
  const touchMode = coarsePointer ? (isLocal ? "local" : isOnline ? "online" : null) : null;
  const touchOnlineFocusMode = touchMode === "online" && onlineFocusMode;
  const splitTouchLocal = touchMode === "local" && orientation === "landscape";
  const showTouchControls = Boolean(touchMode) && gameState.status === "running";
  const desktopGameMode = !isMenu && !touchMode;
  const shouldRenderPhaser = !isMenu;
  const floatingTouchLocal = touchMode === "local" && !splitTouchLocal;
  const floatingTouchOnline = touchMode === "online" && !touchOnlineFocusMode;
  const mobileMenu = coarsePointer && isMenu;
  const compactTopPanel = Boolean(touchMode) || mobileMenu || desktopGameMode;
  const showHeader = !splitTouchLocal && !touchOnlineFocusMode && !(Boolean(touchMode) && !isMenu);
  const showTouchArenaSummary = Boolean(touchMode) && !isMenu && !splitTouchLocal && !touchOnlineFocusMode;
  const shouldLockBodyScroll = Boolean(touchMode);
  const arenaSizeClass =
    touchOnlineFocusMode
      ? "h-full min-h-0"
      : splitTouchLocal
      ? "h-[min(67svh,16.5rem)] min-h-[12.5rem] sm:h-[min(70svh,18.5rem)]"
      : floatingTouchLocal
        ? "h-[min(37svh,16rem)] min-h-[11.5rem] sm:h-[min(41svh,17.5rem)] sm:min-h-[12.5rem]"
      : touchMode === "online"
        ? "h-[min(42svh,17.5rem)] min-h-[12.5rem] sm:h-[min(46svh,19rem)] sm:min-h-[13.5rem]"
      : desktopGameMode
        ? "h-[min(calc(100svh-14rem),40rem)] min-h-[23rem] xl:h-[min(calc(100svh-13rem),44rem)]"
      : mobileMenu
        ? "h-[min(50svh,18rem)] min-h-[17rem]"
      : "h-[min(62vh,32rem)] min-h-[360px] xl:h-[min(66vh,38rem)]";
  const handleToggleFullscreen = () => {
    void fullscreen.toggle(shellRef.current);
  };
  const handleToggleTouchFullscreen = () => {
    if (touchMode === "online") {
      setOnlineFocusMode((current) => !current);
      return;
    }

    void fullscreen.toggle(shellRef.current);
  };
  const touchFullscreenEnabled = touchMode === "online" ? true : Boolean(touchMode) && fullscreen.supported;
  const roomStatusLabel = [
    online.roomId ? `Room ${online.roomId}` : "Aucune room active",
    online.ownSnakeId ? `Vous: ${online.ownSnakeId.toUpperCase()}` : null,
    showOnlineWaiting
      ? online.connectedPlayers > 0
        ? `En attente (${Math.min(online.connectedPlayers, 2)}/2)`
        : "En attente d'un adversaire"
      : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const controlsLabel =
    splitTouchLocal
      ? "Mobile local paysage: un pad par joueur, chacun garde son cote."
      : touchMode === "local"
        ? "Mode tactile local."
        : touchMode === "online"
          ? "Mode tactile online."
          : toControlLabel(mode);
  const shouldRenderFooter =
    !isMenu && !splitTouchLocal && !touchMode && !touchOnlineFocusMode && !mobileMenu && !desktopGameMode;
  const roundLabel = session.roundNumber > 0 ? `Manche ${session.roundNumber}` : null;
  const sessionScoreLabel = `${session.player1Wins} - ${session.player2Wins}`;
  const phaseLabel = isMenu
    ? "Menu"
    : isMatchmaking
      ? "Matchmaking"
      : isOnline
        ? showOnlineWaiting
          ? "Room en attente"
          : "Online"
        : isLocal
          ? "Local"
          : "Arena";
  const headerTitle = isMenu
    ? "Duel local ou online"
    : isMatchmaking
      ? "Recherche d'adversaire"
      : showOnlineWaiting
        ? "Room en attente"
        : roundLabel
          ? `${roundLabel} en cours`
          : "Snake Duel Arena";
  const headerSubtitle = isMenu
    ? "Arena en wrap, inputs bufferises et rematchs synchronises pour des duels plus lisibles."
    : isMatchmaking
      ? "Connexion au matchmaking Colyseus en cours."
      : isOnline
        ? roomStatusLabel
        : paused
          ? "Pause locale. Reprenez la manche quand vous voulez."
          : `Session ${sessionScoreLabel}`;
  const touchSummaryLabel = showOnlineWaiting
    ? `En attente ${Math.min(online.connectedPlayers, 2)}/2`
    : isOnline
      ? online.ownSnakeId?.toUpperCase() ?? "ONLINE"
      : paused
        ? "PAUSE"
        : "RUN";
  const desktopHeaderActionLabel =
    desktopGameMode
      ? isLocal && gameState.status !== "game_over"
        ? paused
          ? "Reprendre"
          : "Pause"
        : isOnline && gameState.status !== "game_over"
          ? "Quitter la room"
          : null
      : null;

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
    if (mode !== "online" || !coarsePointer) {
      setOnlineFocusMode(false);
    }
  }, [coarsePointer, mode]);

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
  const handleDesktopHeaderAction = () => {
    if (isLocal && gameState.status !== "game_over") {
      togglePause();
      return;
    }

    if (isOnline && gameState.status !== "game_over") {
      returnToMenu();
    }
  };

  return (
    <main
      ref={shellRef}
      className={`app-shell relative overflow-x-hidden text-slate-100 ${
        desktopGameMode
          ? "px-4 py-3 sm:px-5 sm:py-3 lg:px-6 lg:py-3"
          : splitTouchLocal
            ? "px-4 pb-4 sm:px-6 sm:pb-5 lg:px-8"
            : "px-4 py-5 sm:px-6 sm:py-6 lg:px-8"
      } ${
        splitTouchLocal
          ? "app-shell--touch-side"
          : desktopGameMode
            ? "app-shell--desktop-game"
          : touchMode === "local"
          ? "app-shell--touch-local"
          : touchMode === "online"
            ? "app-shell--touch-online"
            : ""
      } ${touchOnlineFocusMode ? "app-shell--touch-online-focus" : ""} ${
        floatingTouchLocal ? "app-shell--floating-local-dock" : ""
      } ${floatingTouchOnline ? "app-shell--floating-online-dock" : ""}`}
    >
      <div
        className={`mx-auto flex w-full flex-col ${
          touchOnlineFocusMode
            ? "h-full max-w-none gap-3"
            : desktopGameMode
              ? "max-w-[56rem] gap-3 sm:gap-4 xl:max-w-[60rem]"
            : splitTouchLocal
              ? "max-w-6xl gap-2 sm:gap-3"
              : "gap-5"
        }`}
      >
        {showHeader ? (
          <header
            className={`glass-panel flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between ${
              compactTopPanel ? "p-3 sm:p-4" : "p-4 sm:p-5"
            }`}
          >
            <div>
              <p className="text-[10px] uppercase tracking-[0.32em] text-cyan-200/70">
                Snake Duel Arena
              </p>
              <h1
                className={`mt-1 font-black tracking-tight ${
                  compactTopPanel ? "text-xl sm:text-2xl" : "text-2xl sm:text-3xl"
                }`}
              >
                {headerTitle}
              </h1>
              <p
                className={`mt-1 text-slate-300 ${
                  compactTopPanel ? "text-[11px] sm:text-xs" : "text-xs sm:text-sm"
                }`}
              >
                {headerSubtitle}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <InfoChip label={phaseLabel} accent="teal" />
                {roundLabel ? <InfoChip label={roundLabel} /> : null}
                {!isMenu ? <InfoChip label={`Session ${sessionScoreLabel}`} accent="orange" /> : null}
                {isOnline && online.ownSnakeId ? (
                  <InfoChip label={online.ownSnakeId.toUpperCase()} />
                ) : null}
                {isMenu ? (
                  <>
                    <InfoChip label="Wrap arena" />
                    <InfoChip label="Buffer x3" />
                    <InfoChip label="Clavier + tactile" />
                  </>
                ) : null}
              </div>
              {desktopGameMode ? (
                <p className="mt-2 max-w-2xl text-[11px] leading-relaxed text-slate-300/88 sm:text-xs">
                  {controlsLabel}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col items-end gap-2">
              {isMenu && mobileMenu ? null : (
                <div
                  className={`grid grid-cols-2 gap-2 ${
                    compactTopPanel ? "text-[11px]" : "text-xs sm:text-sm"
                  }`}
                >
                  {isMenu ? (
                    <>
                      <StatCard
                        title="Local"
                        value="Instantane"
                        detail="2 joueurs, clavier et tactile"
                        accent="teal"
                        compact={compactTopPanel}
                      />
                      <StatCard
                        title="Online"
                        value="Autoritaire"
                        detail="Matchmaking, room sync et rematch"
                        accent="orange"
                        compact={compactTopPanel}
                      />
                    </>
                  ) : (
                    <>
                      <StatCard
                        title="J1"
                        value={`${session.player1Wins} manche${session.player1Wins > 1 ? "s" : ""}`}
                        detail={`${player1?.score ?? 0} pts • L${player1?.body.length ?? 0}`}
                        accent="teal"
                        compact={compactTopPanel}
                      />
                      <StatCard
                        title="J2"
                        value={`${session.player2Wins} manche${session.player2Wins > 1 ? "s" : ""}`}
                        detail={`${player2?.score ?? 0} pts • L${player2?.body.length ?? 0}`}
                        accent="orange"
                        compact={compactTopPanel}
                      />
                    </>
                  )}
                </div>
              )}
              {desktopHeaderActionLabel ? (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleDesktopHeaderAction}
                >
                  {desktopHeaderActionLabel}
                </button>
              ) : null}
            </div>
          </header>
        ) : null}

        <section
          className={`glass-panel relative overflow-hidden ${
            touchOnlineFocusMode
              ? "flex-1 min-h-0 p-2 sm:p-3"
              : splitTouchLocal
                ? "p-2 sm:p-3"
                : compactTopPanel
                  ? "p-2 sm:p-3"
                  : "p-3 sm:p-4"
          } ${arenaSizeClass}`}
        >
          <div
            className={`relative h-full w-full rounded-2xl border border-slate-700/60 bg-[#030711]/70 p-2 ${
              desktopGameMode ? "flex items-center justify-center" : ""
            }`}
          >
            {showTouchArenaSummary ? (
              <div className="arena-summary">
                <div className="arena-summary__chips">
                  <InfoChip label={phaseLabel} accent={isOnline ? "orange" : "teal"} compact />
                  {roundLabel ? <InfoChip label={roundLabel} compact /> : null}
                  <InfoChip label={touchSummaryLabel} compact />
                </div>
                <div className="arena-summary__scores">
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
            ) : null}

            <div className={desktopGameMode ? "h-full aspect-square max-w-full" : "h-full w-full"}>
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
            </div>

            <AnimatePresence>
              {isMenu ? (
                <motion.div
                  key="menu"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16, ease: "easeOut" }}
                  className="overlay-panel"
                >
                  <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Duel prêt</h2>
                  <p className="mt-2 max-w-md text-center text-sm text-slate-300">
                    Joue en local instantané ou en ligne via Colyseus matchmaking.
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
                  {online.lastError ? (
                    <p className="mt-4 text-center text-xs text-rose-300">{online.lastError}</p>
                  ) : null}
                </motion.div>
              ) : null}
            </AnimatePresence>

            <AnimatePresence>
              {isMatchmaking ? (
                <motion.div
                  key="matchmaking"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16, ease: "easeOut" }}
                  className="overlay-subpanel"
                >
                  <div className="loader-orbit" />
                  <p className="mt-4 text-xs uppercase tracking-[0.28em] text-slate-300">
                    Matchmaking
                  </p>
                  <p className="mt-1 text-sm text-slate-300">Recherche d'un adversaire...</p>
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
                  transition={{ duration: 0.16, ease: "easeOut" }}
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
              {paused ? (
                <motion.div
                  key="paused"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16, ease: "easeOut" }}
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
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
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
              fullscreenSupported={fullscreen.supported}
              fullscreenActive={fullscreen.active}
              onToggleFullscreen={handleToggleFullscreen}
            />
          ) : showTouchControls && touchMode ? (
            <TouchControlsDock
              mode={touchMode}
              floating={floatingTouchLocal || floatingTouchOnline}
              compact={floatingTouchLocal}
              suggestLandscape={touchMode === "local"}
              fullscreenSupported={touchFullscreenEnabled}
              fullscreenActive={touchMode === "online" ? touchOnlineFocusMode : fullscreen.active}
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

        {shouldRenderFooter ? (
          <footer
            className={`glass-panel flex flex-wrap items-center justify-between gap-3 text-slate-300 ${
              compactTopPanel ? "p-3 text-[11px] sm:text-xs" : "p-4 text-xs sm:text-sm"
            }`}
          >
            <p>{controlsLabel}</p>
            {isLocal && gameState.status !== "game_over" ? (
              <button type="button" className="btn-secondary" onClick={togglePause}>
                {paused ? "Reprendre" : "Pause"}
              </button>
            ) : null}
            {isOnline && gameState.status !== "game_over" ? (
              <button type="button" className="btn-secondary" onClick={returnToMenu}>
                Quitter la room
              </button>
            ) : null}
          </footer>
        ) : null}
      </div>
    </main>
  );
}

interface InfoChipProps {
  readonly label: string;
  readonly accent?: "teal" | "orange" | "slate";
  readonly compact?: boolean;
}

function InfoChip({ label, accent = "slate", compact = false }: InfoChipProps) {
  const palette =
    accent === "teal"
      ? "border-cyan-400/25 bg-cyan-400/10 text-cyan-50"
      : accent === "orange"
        ? "border-orange-400/28 bg-orange-400/10 text-orange-50"
        : "border-slate-500/40 bg-slate-800/60 text-slate-200";

  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 font-semibold uppercase tracking-[0.18em] ${palette} ${
        compact ? "text-[9px]" : "text-[10px]"
      }`}
    >
      {label}
    </span>
  );
}

interface CompactArenaScoreProps {
  readonly title: string;
  readonly value: string;
  readonly accent: "teal" | "orange";
}

function CompactArenaScore({ title, value, accent }: CompactArenaScoreProps) {
  return (
    <div className={`arena-score-pill arena-score-pill--${accent}`}>
      <span className="arena-score-pill__title">{title}</span>
      <span className="arena-score-pill__value">{value}</span>
    </div>
  );
}

interface StatCardProps {
  readonly title: string;
  readonly value: string;
  readonly detail: string;
  readonly accent: "teal" | "orange";
  readonly compact?: boolean;
}

function StatCard({ title, value, detail, accent, compact = false }: StatCardProps) {
  return (
    <div
      className={`rounded-xl border px-3 py-2 ${
        accent === "teal"
          ? "border-teal-400/40 bg-teal-400/10"
          : "border-orange-400/40 bg-orange-400/10"
      }`}
    >
      <p className="text-[10px] uppercase tracking-[0.16em] text-slate-300">{title}</p>
      <p className={`mt-1 font-bold ${compact ? "text-sm sm:text-base" : "text-base"}`}>{value}</p>
      <p className={`${compact ? "text-[10px] sm:text-[11px]" : "text-[11px]"} text-slate-300`}>
        {detail}
      </p>
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
  return "Partie terminée";
}

function toControlLabel(mode: string): string {
  if (mode === "local") {
    return "Clavier local: WASD (J1), flèches (J2), espace (pause)";
  }
  if (mode === "online") {
    return "Clavier online: WASD ou flèches (votre serpent)";
  }
  if (mode === "matchmaking") {
    return "Connexion en cours au matchmaking Colyseus...";
  }
  return "Choisissez un mode puis lancez la partie.";
}

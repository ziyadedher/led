"use client";

import { PowerIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSWRConfig } from "swr";

import { Composer } from "@/app/components/Composer";
import { type ColorState } from "@/app/components/ColorPicker";
import { CornerBracket } from "@/app/components/ComposerShell";
import {
  FORCE_ENABLE_MARQUEE_LENGTH,
  type EffectsState,
} from "@/app/components/EffectsPanel";
import { EntriesList } from "@/app/components/EntriesList";
import { InstrumentHeader } from "@/app/components/InstrumentHeader";
import { MatrixPreview } from "@/app/components/MatrixPreview";
import { PanelSwitcher } from "@/app/components/PanelSwitcher";
import { StatusBar } from "@/app/components/StatusBar";
import { PanelContext } from "@/app/context";
import { SCENES } from "@/app/scenes";
import { parseLifeConfig, useLifeScene } from "@/app/scenes/life";
import { ModeSwitcher } from "@/app/scenes/ModeSwitcher";
import { MODES } from "@/app/scenes/types";
import {
  entries,
  panels,
  type PanelMode,
  useRealtimeRevalidation,
} from "@/utils/actions";
import { isOffline, relativeTime } from "@/utils/offline";
import { useNow } from "@/utils/useNow";

const AUTO_FORCED_DEFAULT = 10;

export default function Page() {
  const realtimeStatus = useRealtimeRevalidation();
  const { mutate } = useSWRConfig();
  const { data: panelsData } = panels.get.useSWR();

  const [chosenPanelId, setChosenPanelId] = useState<string | null>(null);
  const defaultPanelId = useMemo(() => {
    if (!panelsData || panelsData.length === 0) return "";
    return panelsData[0].id;
  }, [panelsData]);
  // Drop the chosen pin when its panel disappears server-side. Set
  // during render — React 19 deduplicates and skips the extra paint.
  if (
    chosenPanelId != null &&
    panelsData &&
    !panelsData.some((p) => p.id === chosenPanelId)
  ) {
    setChosenPanelId(null);
  }
  const panelId = chosenPanelId ?? defaultPanelId;
  const activePanel = panelsData?.find((p) => p.id === panelId);

  // Resolve the active mode against the SCENES registry. Anything
  // unknown falls through to text mode.
  const activeMode: PanelMode = MODES.some((m) => m.id === activePanel?.mode)
    ? (activePanel!.mode as PanelMode)
    : "text";
  const frame = SCENES[activeMode];

  // 1Hz tick for the clock simulator + offline indicator.
  const now = useNow(1_000);
  const activePanelOffline = isOffline(activePanel?.last_seen, now);

  // Composer state (text mode).
  const [message, setMessage] = useState("");
  const [color, setColor] = useState<ColorState>({
    mode: "rgb",
    rgb: { r: 255, g: 138, b: 44 },
  });
  const [effects, setEffects] = useState<EffectsState>({ marqueeSpeed: 0 });

  const isSubmittable =
    activeMode === "text" && message.length > 0 && panelId.length > 0;
  const isMarqueeForced = message.length >= FORCE_ENABLE_MARQUEE_LENGTH;

  const wasForced = useRef(false);
  useEffect(() => {
    if (isMarqueeForced && !wasForced.current && effects.marqueeSpeed === 0) {
      setEffects((e) => ({ ...e, marqueeSpeed: AUTO_FORCED_DEFAULT }));
    }
    wasForced.current = isMarqueeForced;
  }, [isMarqueeForced, effects.marqueeSpeed]);

  const effectiveMarqueeSpeed =
    isMarqueeForced && effects.marqueeSpeed === 0
      ? AUTO_FORCED_DEFAULT
      : effects.marqueeSpeed;

  const handleSubmit = useCallback(async () => {
    if (!panelId) return;
    const wireColor =
      color.mode === "rgb"
        ? { Rgb: color.rgb }
        : {
            Rainbow: {
              is_per_letter: color.perLetter,
              speed: color.speed,
            },
          };
    await entries.add.call(panelId, {
      text: message,
      options: {
        color: wireColor,
        marquee: { speed: effectiveMarqueeSpeed },
      },
    });
    setMessage("");
    await mutate(`/entries/${panelId}`);
  }, [color, message, mutate, panelId, effectiveMarqueeSpeed]);

  // Parse the active mode's config once per mode_config change. Only
  // the active mode's parser runs.
  const activeConfig = useMemo(
    () => frame.parse(activePanel?.mode_config),
    [frame, activePanel?.mode_config],
  );

  // Life mode owns its own animation loop (rAF-driven cellular tick).
  // Always running so previewing is instant when the user switches
  // in. Bypasses the SCENES registry's erased types — this is the
  // one consumer that needs the life-typed config directly.
  const lifeConfig = useMemo(
    () => parseLifeConfig(activePanel?.mode_config),
    [activePanel?.mode_config],
  );
  const lifeScene = useLifeScene(lifeConfig);

  // Build the Scene the simulator renders. Clock mode samples
  // `now` internally, so its memo needs to re-run each tick — but
  // only for clock; otherwise we'd re-stringify the entire scene
  // (up to ~720KB for a fully-loaded gif) every second on the main
  // thread for nothing. Hide `now` behind a mode-gated dep.
  const clockTick = activeMode === "clock" ? now : 0;
  const modeFrame = useMemo(
    () =>
      frame.buildFrame(activeConfig, {
        message,
        color,
        marqueeSpeed: effectiveMarqueeSpeed,
        lifeScene,
      }),
    // eslint can't see through frame.buildFrame to know clock reads
    // wall-clock time; clockTick keeps the dep array honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      frame,
      activeConfig,
      message,
      color,
      effectiveMarqueeSpeed,
      lifeScene,
      clockTick,
    ],
  );

  return (
    <PanelContext.Provider value={panelId}>
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-5 px-4 pb-12 sm:px-6 lg:px-10">
        <InstrumentHeader realtimeStatus={realtimeStatus} />

        {/* ─── instrument: matrix simulator ──────────────────────── */}
        <section
          className="grid gap-4 lg:grid-cols-[1fr_240px]"
          aria-label="Live simulator"
        >
          <div className="relative">
            {/* Section heading plate — instrument-label feel */}
            <div className="mb-3 flex items-stretch border border-(--color-border) bg-gradient-to-b from-(--color-surface-2)/60 to-(--color-surface)/40">
              <div className="flex min-w-0 items-center gap-2 border-r border-(--color-border) px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.3em]">
                <span className="text-(--color-accent)">::</span>
                <span className="text-(--color-text)">simulator</span>
                <span className="hidden text-(--color-text-faint) sm:inline">
                  /
                </span>
                <span className="hidden text-(--color-text-muted) sm:inline">
                  wasm · driver-core
                </span>
              </div>

              <span aria-hidden className="flex-1" />

              {/* Pause / Live transport button */}
              {panelId.length > 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    void panels.setPaused.call(
                      panelId,
                      !(activePanel?.is_paused ?? false),
                    )
                  }
                  aria-label={
                    activePanel?.is_paused ? "Resume panel" : "Pause panel"
                  }
                  title={`last seen ${relativeTime(activePanel?.last_seen, now)} · click to ${activePanel?.is_paused ? "resume" : "pause"}`}
                  className={[
                    "flex items-center gap-2 border-l border-(--color-border) px-3 py-1.5 text-[10px] uppercase tracking-[0.3em] transition-colors",
                    activePanel?.is_paused
                      ? "bg-(--color-accent)/10 text-(--color-accent)"
                      : activePanelOffline
                        ? "text-(--color-danger)"
                        : "text-(--color-phosphor) hover:bg-(--color-surface-2)",
                  ].join(" ")}
                >
                  <span
                    aria-hidden
                    className={
                      activePanel?.is_paused || activePanelOffline
                        ? ""
                        : "h-1.5 w-1.5 animate-pulse rounded-full bg-(--color-phosphor)"
                    }
                    style={
                      activePanel?.is_paused || activePanelOffline
                        ? { fontFamily: "var(--font-pixel)", fontSize: 12 }
                        : undefined
                    }
                  >
                    {activePanel?.is_paused
                      ? "▶"
                      : activePanelOffline
                        ? "✕"
                        : ""}
                  </span>
                  <span>
                    {activePanel?.is_paused
                      ? "paused"
                      : activePanelOffline
                        ? "offline"
                        : "live"}
                  </span>
                </button>
              ) : null}

              {/* Off / On hardware-power transport. Composes with
                * pause: "off" short-circuits the driver to a black
                * frame without losing the panel's mode/config or
                * queued entries — flip back to resume the same
                * scene. */}
              {panelId.length > 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    void panels.setOff.call(
                      panelId,
                      !(activePanel?.is_off ?? false),
                    )
                  }
                  aria-label={
                    activePanel?.is_off ? "Turn panel on" : "Turn panel off"
                  }
                  title={
                    activePanel?.is_off
                      ? "click to turn on (resumes current mode)"
                      : "click to turn off (panel goes dark; mode + queue preserved)"
                  }
                  className={[
                    "flex items-center gap-2 border-l border-(--color-border) px-3 py-1.5 text-[10px] uppercase tracking-[0.3em] transition-colors",
                    activePanel?.is_off
                      ? "bg-(--color-danger)/10 text-(--color-danger)"
                      : activePanelOffline
                        ? "text-(--color-text-faint)"
                        : "text-(--color-text-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)",
                  ].join(" ")}
                >
                  <PowerIcon aria-hidden className="h-3.5 w-3.5" />
                  <span>{activePanel?.is_off ? "off" : "on"}</span>
                </button>
              ) : null}

              {/* Format chip — pixel font for the resolution. Hidden
                * on phones where the chrome row is too tight to show
                * pause / off / format together. */}
              <div className="hidden items-center gap-2 border-l border-(--color-border) px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.3em] text-(--color-text-faint) tabular-nums sm:flex">
                <span style={{ fontFamily: "var(--font-pixel)", fontSize: 14 }}>
                  64×64
                </span>
                <span aria-hidden className="text-(--color-border-strong)">
                  /
                </span>
                <span style={{ fontFamily: "var(--font-pixel)", fontSize: 14 }}>
                  rgb888
                </span>
              </div>
            </div>

            <div className="relative">
              <CornerBracket pos="tl" size="lg" />
              <CornerBracket pos="tr" size="lg" />
              <CornerBracket pos="bl" size="lg" />
              <CornerBracket pos="br" size="lg" />
              <MatrixPreview
                offline={activePanelOffline}
                mode={modeFrame}
                isPaused={activePanel?.is_paused ?? false}
                isOff={activePanel?.is_off ?? false}
              />
            </div>
          </div>

          {/* Side rail: target selector */}
          <aside className="flex flex-col gap-4">
            <PanelSwitcher panelId={panelId} onChange={setChosenPanelId} />
          </aside>
        </section>

        {/* ─── mode switcher ─────────────────────────────────────── */}
        {panelId.length > 0 ? (
          <ModeSwitcher panelId={panelId} current={activeMode} />
        ) : null}

        {/* ─── per-mode bottom half ──────────────────────────────── */}
        {activeMode === "text" ? (
          // Text mode is special — it pairs the composer with the live
          // entries queue, side by side on lg+. Other modes are
          // single-pane composers and route through SCENES[mode].Composer.
          <div className="grid flex-1 gap-6 lg:grid-cols-[1fr_1fr]">
            <Composer
              message={message}
              onMessageChange={setMessage}
              color={color}
              onColorChange={setColor}
              effects={effects}
              onEffectsChange={setEffects}
              onSubmit={handleSubmit}
              disabled={!isSubmittable}
            />
            <section
              className="flex min-h-0 flex-col gap-3"
              aria-label="Messages"
            >
              <div className="flex items-stretch border border-(--color-border) bg-gradient-to-b from-(--color-surface-2)/60 to-(--color-surface)/40">
                <div className="flex items-center gap-2 border-r border-(--color-border) px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.3em]">
                  <span className="text-(--color-accent)">::</span>
                  <span className="text-(--color-text)">queue</span>
                </div>
                <span aria-hidden className="flex-1" />
                <div className="hidden items-center gap-2 border-l border-(--color-border) px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.3em] text-(--color-text-faint) sm:flex">
                  <span>top 7 on-air · drag to reorder</span>
                </div>
              </div>
              <EntriesList />
            </section>
          </div>
        ) : (
          <frame.Composer panelId={panelId} config={activeConfig} />
        )}

        <StatusBar
          panelName={activePanel?.name ?? null}
          panelMode={activeMode}
          driverVersion={activePanel?.driver_version ?? null}
          isPanelPaused={activePanel?.is_paused ?? false}
          lastSeen={activePanel?.last_seen ?? null}
          panelId={panelId}
          now={now}
        />
      </div>
    </PanelContext.Provider>
  );
}

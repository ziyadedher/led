"use client";

import { PowerIcon } from "@heroicons/react/24/outline";
import { useCallback, useMemo, useState } from "react";

import { BrightnessControl } from "@/app/components/BrightnessControl";
import { Composer } from "@/app/components/Composer";
import { type ColorState } from "@/app/components/ColorPicker";
import { CornerBracket } from "@/app/components/ComposerShell";
import {
  FORCE_ENABLE_MARQUEE_LENGTH,
  type EffectsState,
} from "@/app/components/EffectsPanel";
import { EntriesList } from "@/app/components/EntriesList";
import { InstrumentHeader } from "@/app/components/InstrumentHeader";
import { MatrixFrame, MatrixPreview } from "@/app/components/MatrixPreview";
import {
  PANEL_CONTENT_ID,
  PanelSwitcher,
} from "@/app/components/PanelSwitcher";
import {
  PlateButton,
  PlateCell,
  SectionPlate,
} from "@/app/components/SectionPlate";
import { StatusBar } from "@/app/components/StatusBar";
import { Lamp, PixelValue } from "@/app/components/ui";
import { PanelContext } from "@/app/context";
import { SCENES } from "@/app/scenes";
import { parseLifeConfig, useLifeScene } from "@/app/scenes/life";
import { MODE_CONTENT_ID, ModeSwitcher } from "@/app/scenes/ModeSwitcher";
import { MODES } from "@/app/scenes/types";
import {
  entries,
  panels,
  type PanelMode,
  useRealtimeRevalidation,
} from "@/utils/actions";
import { LED_ORANGE } from "@/utils/color";
import { isOffline, relativeTime } from "@/utils/offline";
import { useNow } from "@/utils/useNow";
import { useReducedMotion } from "@/utils/useReducedMotion";

/** Marquee speed applied when a long payload force-enables the
 * marquee while the user has it at 0. EffectsPanel's
 * `autoForcedSpeed` default mirrors this so display and wire value
 * can't diverge. */
const AUTO_FORCED_DEFAULT = 10;

export default function Page() {
  const realtimeStatus = useRealtimeRevalidation();
  const { data: panelsData, isLoading: panelsLoading } = panels.get.useSWR();

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

  // Resolve the active panel + its mode in one pass instead of
  // re-scanning panelsData with find/some/find every render. Unknown
  // modes fall through to text.
  const { activePanel, activeMode } = useMemo(() => {
    const panel = panelsData?.find((p) => p.id === panelId);
    const mode: PanelMode = MODES.some((m) => m.id === panel?.mode)
      ? (panel!.mode as PanelMode)
      : "text";
    return { activePanel: panel, activeMode: mode };
  }, [panelsData, panelId]);
  const frame = SCENES[activeMode];

  const hasPanels = (panelsData?.length ?? 0) > 0;

  // 1Hz tick for the clock simulator + offline indicator.
  const now = useNow(1_000);
  const activePanelOffline = isOffline(activePanel?.last_seen, now);

  // Composer state (text mode).
  const [message, setMessage] = useState("");
  const [color, setColor] = useState<ColorState>({
    mode: "rgb",
    rgb: LED_ORANGE,
  });
  const [effects, setEffects] = useState<EffectsState>({ marqueeSpeed: 0 });
  const [submitError, setSubmitError] = useState(false);

  // Switching panels starts a fresh composition. Reset composer
  // effects and clear any stale transmit-failure flag — done during
  // render via the documented "adjust state when a prop changes"
  // pattern (matches the chosenPanelId reset above). The reset is
  // message-aware: a still-long payload re-applies the auto-forced
  // marquee default immediately, which used to be handled by a pair
  // of effects whose ordering left the state at 0-while-forced (UI
  // showed 01, the wire carried 10).
  const [effectsPanelId, setEffectsPanelId] = useState(panelId);
  if (effectsPanelId !== panelId) {
    setEffectsPanelId(panelId);
    setEffects({
      marqueeSpeed:
        message.length >= FORCE_ENABLE_MARQUEE_LENGTH
          ? AUTO_FORCED_DEFAULT
          : 0,
    });
    setSubmitError(false);
  }

  const isSubmittable =
    activeMode === "text" && message.length > 0 && panelId.length > 0;
  const isMarqueeForced = message.length >= FORCE_ENABLE_MARQUEE_LENGTH;

  // A long payload with the slider at 0 transmits at the auto-forced
  // default; EffectsPanel displays the same value via autoForcedSpeed.
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
    setSubmitError(false);
    try {
      // actions.ts inserts optimistically + rolls back on error, so the
      // queue updates instantly and no manual mutate is needed.
      await entries.add.call(panelId, {
        text: message,
        options: {
          color: wireColor,
          marquee: { speed: effectiveMarqueeSpeed },
        },
      });
    } catch (e) {
      setSubmitError(true);
      // Re-throw so the Composer keeps the message + skips its
      // success-only input refocus.
      throw e;
    }
    // Only clear the payload once the transmit is confirmed.
    setMessage("");
  }, [color, message, panelId, effectiveMarqueeSpeed]);

  // Parse the active mode's config once per mode_config change. Only
  // the active mode's parser runs.
  const activeConfig = useMemo(
    () => frame.parse(activePanel?.mode_config),
    [frame, activePanel?.mode_config],
  );

  // Life mode owns its own animation loop (rAF-driven cellular tick).
  // Bypasses the SCENES registry's erased types — this is the one
  // consumer that needs the life-typed config directly. The ticker
  // must gate on reduced-motion and paused/off itself: each
  // generation's new cells array would otherwise push a fresh scene
  // through MatrixPreview's idle-wake path and animate right past the
  // preview's own motion gates.
  const reducedMotion = useReducedMotion();
  const lifeConfig = useMemo(
    () => parseLifeConfig(activePanel?.mode_config),
    [activePanel?.mode_config],
  );
  const lifeScene = useLifeScene(
    lifeConfig,
    activeMode === "life" &&
      !reducedMotion &&
      !activePanelOffline &&
      !(activePanel?.is_paused ?? false) &&
      !(activePanel?.is_off ?? false),
  );

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
      <InstrumentHeader realtimeStatus={realtimeStatus} />
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-5 px-4 pt-5 pb-12 sm:px-6 lg:px-10">
        {/* ─── instrument: matrix simulator ──────────────────────── */}
        <section className="grid gap-4 lg:grid-cols-[1fr_240px]">
          {/* This div is the tabpanel the PanelSwitcher tabs drive
            * (each tab's aria-controls points at PANEL_CONTENT_ID). It
            * deliberately excludes the <aside> holding the tablist —
            * a tabpanel containing its own tabs is a circular ARIA
            * relationship. When a panel is selected we label it by its
            * tab; otherwise a static label so AT still announces the
            * region. */}
          <div
            id={PANEL_CONTENT_ID}
            role="tabpanel"
            aria-label={hasPanels && panelId ? undefined : "Live simulator"}
            aria-labelledby={
              hasPanels && panelId ? `panel-tab-${panelId}` : undefined
            }
            className="relative"
          >
            {/* Section heading plate — instrument-label feel */}
            <SectionPlate
              title="simulator"
              subtitle="wasm · driver-core"
              className="mb-3"
            >
              {/* Global brightness fader — final multiply, alongside
                * the pause/off transport. */}
              {panelId.length > 0 ? (
                <BrightnessControl
                  panelId={panelId}
                  brightness={activePanel?.brightness ?? 1}
                  disabled={activePanelOffline}
                />
              ) : null}

              {/* Pause / Live transport button */}
              {panelId.length > 0 ? (
                <PlateButton
                  onClick={() =>
                    void panels.setPaused.call(
                      panelId,
                      !(activePanel?.is_paused ?? false),
                    )
                  }
                  ariaLabel={
                    activePanel?.is_paused ? "Resume panel" : "Pause panel"
                  }
                  title={`last seen ${relativeTime(activePanel?.last_seen, now)} · click to ${activePanel?.is_paused ? "resume" : "pause"}`}
                  tone={
                    activePanel?.is_paused
                      ? "text-(--color-accent) hover:bg-(--color-accent)/20"
                      : activePanelOffline
                        ? "text-(--color-danger) hover:bg-(--color-surface-3)"
                        : "text-(--color-phosphor) hover:bg-(--color-surface-3)"
                  }
                >
                  {activePanel?.is_paused || activePanelOffline ? (
                    <span aria-hidden>
                      <PixelValue size="sm">
                        {activePanel?.is_paused ? "▶" : "✕"}
                      </PixelValue>
                    </span>
                  ) : (
                    <Lamp tone="phosphor" pulse glow={false} />
                  )}
                  <span>
                    {activePanel?.is_paused
                      ? "paused"
                      : activePanelOffline
                        ? "offline"
                        : "live"}
                  </span>
                </PlateButton>
              ) : null}

              {/* Off / On hardware-power transport. Composes with
                * pause: "off" short-circuits the driver to a black
                * frame without losing the panel's mode/config or
                * queued entries — flip back to resume the same scene.
                * The consequence lives in the accessible name, not
                * just the title (tooltips don't exist on touch). */}
              {panelId.length > 0 ? (
                <PlateButton
                  onClick={() =>
                    void panels.setOff.call(
                      panelId,
                      !(activePanel?.is_off ?? false),
                    )
                  }
                  ariaLabel={
                    activePanel?.is_off
                      ? "Turn panel on — resumes the current mode"
                      : "Turn panel off — mode and queue preserved"
                  }
                  title={
                    activePanel?.is_off
                      ? "click to turn on (resumes current mode)"
                      : "click to turn off (panel goes dark; mode + queue preserved)"
                  }
                  tone={
                    activePanel?.is_off
                      ? "text-(--color-danger) hover:bg-(--color-danger)/20"
                      : activePanelOffline
                        ? "text-(--color-text-faint) hover:bg-(--color-surface-3)"
                        : "text-(--color-text-muted) hover:bg-(--color-surface-3) hover:text-(--color-text)"
                  }
                >
                  <PowerIcon aria-hidden className="h-3.5 w-3.5" />
                  <span>{activePanel?.is_off ? "off" : "on"}</span>
                </PlateButton>
              ) : null}

              {/* Format chip — pixel font for the resolution */}
              <PlateCell className="tabular-nums">
                <PixelValue size="md">64×64</PixelValue>
                <span aria-hidden className="text-(--color-border-strong)">
                  /
                </span>
                <PixelValue size="md">rgb888</PixelValue>
              </PlateCell>
            </SectionPlate>

            <div className="relative">
              <CornerBracket pos="tl" size="lg" />
              <CornerBracket pos="tr" size="lg" />
              <CornerBracket pos="bl" size="lg" />
              <CornerBracket pos="br" size="lg" />
              {hasPanels ? (
                <MatrixPreview
                  offline={activePanelOffline}
                  mode={modeFrame}
                  isPaused={activePanel?.is_paused ?? false}
                  isOff={activePanel?.is_off ?? false}
                  brightness={activePanel?.brightness ?? 1}
                />
              ) : (
                // Same bezel as the live simulator so the frame doesn't
                // jump when data lands. While the fleet index is still
                // loading we say so — flashing "no panels registered"
                // on every cold start read as a broken fleet.
                <MatrixFrame>
                  <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 text-center font-mono uppercase tracking-[0.3em]">
                    {panelsLoading ? (
                      <>
                        <span className="animate-pulse text-[11px] text-(--color-text-dim)">
                          scanning fleet ···
                        </span>
                        <span className="text-[9px] text-(--color-text-faint)">
                          awaiting first telemetry
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="text-[11px] text-(--color-text-dim)">
                          no panels registered
                        </span>
                        <span className="text-[9px] text-(--color-text-faint)">
                          connect a driver to begin
                        </span>
                      </>
                    )}
                  </div>
                </MatrixFrame>
              )}
            </div>
          </div>

          {/* Side rail: target selector. Ordered above the simulator
            * on phones — picking the target panel is the first
            * decision of a session and used to sit below the fold. */}
          <aside className="order-first flex flex-col gap-4 lg:order-none">
            <PanelSwitcher panelId={panelId} onChange={setChosenPanelId} />
          </aside>
        </section>

        {/* ─── mode switcher ─────────────────────────────────────── */}
        {panelId.length > 0 ? (
          <ModeSwitcher panelId={panelId} current={activeMode} />
        ) : null}

        {/* ─── per-mode bottom half ──────────────────────────────── */}
        {/* Tabpanel for the ModeSwitcher tabs (aria-controls →
          * MODE_CONTENT_ID). Composers remount per panel:mode via the
          * key — paint's bitmap/undo stacks, upload errors, and other
          * instance state must not survive a target switch. */}
        <div
          id={MODE_CONTENT_ID}
          role="tabpanel"
          aria-labelledby={
            hasPanels && panelId ? `mode-tab-${activeMode}` : undefined
          }
          aria-label={hasPanels && panelId ? undefined : "Composer"}
          className="flex flex-1 flex-col"
        >
          {activeMode === "text" ? (
            // Text mode is special — it pairs the composer with the live
            // entries queue, side by side on lg+. Other modes are
            // single-pane composers and route through SCENES[mode].Composer.
            <div className="grid flex-1 gap-6 lg:grid-cols-[1fr_1fr]">
              <Composer
                key={`${panelId}:text`}
                message={message}
                onMessageChange={(s) => {
                  // Editing the payload clears a stale transmit failure.
                  if (submitError) setSubmitError(false);
                  setMessage(s);
                }}
                color={color}
                onColorChange={setColor}
                effects={effects}
                onEffectsChange={setEffects}
                onSubmit={handleSubmit}
                disabled={!isSubmittable}
                transmitFailed={submitError}
              />
              <section
                className="flex min-h-0 flex-col gap-3"
                aria-label="Messages"
              >
                <SectionPlate title="queue">
                  <PlateCell>
                    <span>top 7 on-air · drag to reorder</span>
                  </PlateCell>
                </SectionPlate>
                <EntriesList />
              </section>
            </div>
          ) : (
            <frame.Composer
              key={`${panelId}:${activeMode}`}
              panelId={panelId}
              config={activeConfig}
            />
          )}
        </div>

        <StatusBar
          panelName={activePanel?.name ?? null}
          panelMode={activeMode}
          driverVersion={activePanel?.driver_version ?? null}
          isPanelPaused={activePanel?.is_paused ?? false}
          isPanelOff={activePanel?.is_off ?? false}
          lastSeen={activePanel?.last_seen ?? null}
          panelId={panelId}
          now={now}
        />
      </div>
    </PanelContext.Provider>
  );
}

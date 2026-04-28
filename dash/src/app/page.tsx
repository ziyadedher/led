"use client";

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
import { LiveDot } from "@/app/components/LiveDot";
import { MatrixPreview } from "@/app/components/MatrixPreview";
import { PanelSwitcher } from "@/app/components/PanelSwitcher";
import { PanelContext } from "@/app/context";
import { SCENES } from "@/app/scenes";
import { parseLifeConfig, useLifeFrame } from "@/app/scenes/life";
import { ModeSwitcher } from "@/app/scenes/ModeSwitcher";
import { MODES } from "@/app/scenes/types";
import {
  entries,
  panels,
  type PanelMode,
  useRealtimeRevalidation,
} from "@/utils/actions";
import { isOffline } from "@/utils/offline";
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
  const lifeFrame = useLifeFrame(lifeConfig);

  // Build the ModeFrame the simulator renders. `now` is in deps so
  // clock mode advances each tick.
  const modeFrame = useMemo(
    () =>
      frame.buildFrame(activeConfig, {
        message,
        color,
        marqueeSpeed: effectiveMarqueeSpeed,
        lifeFrame,
      }),
    // `now` reruns the memo every tick — needed for clock mode to
    // pick up the current time. eslint can't see through `frame.buildFrame`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      frame,
      activeConfig,
      message,
      color,
      effectiveMarqueeSpeed,
      lifeFrame,
      now,
    ],
  );

  return (
    <PanelContext.Provider value={panelId}>
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:px-10">
        {/* ─── instrument: matrix simulator ──────────────────────── */}
        <section
          className="grid gap-4 lg:grid-cols-[1fr_220px]"
          aria-label="Live simulator"
        >
          <div className="relative">
            <div className="mb-2 flex items-end justify-between">
              <div className="flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-[0.3em]">
                <span className="text-(--color-text-faint)">::</span>
                <span className="text-(--color-text-dim)">simulator</span>
                <span className="text-(--color-text-faint)">/</span>
                <span className="text-(--color-text-muted)">
                  wasm · driver-core
                </span>
              </div>
              <div className="flex items-center gap-3 font-mono text-[9px] uppercase tracking-[0.3em] text-(--color-text-faint) tabular-nums">
                {panelId.length > 0 ? (
                  <button
                    type="button"
                    onClick={() =>
                      void panels.setPaused.call(
                        panelId,
                        !(activePanel?.is_paused ?? false),
                      )
                    }
                    aria-label={activePanel?.is_paused ? "Resume panel" : "Pause panel"}
                    className={[
                      "inline-flex h-5 items-center gap-1 border px-2 text-[9px] uppercase tracking-[0.3em] transition-colors",
                      activePanel?.is_paused
                        ? "border-(--color-accent) bg-(--color-accent)/15 text-(--color-accent)"
                        : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong) hover:text-(--color-text)",
                    ].join(" ")}
                  >
                    <span aria-hidden style={{ fontFamily: "var(--font-pixel)", fontSize: 11 }}>
                      {activePanel?.is_paused ? "▶" : "❚❚"}
                    </span>
                    <span>{activePanel?.is_paused ? "paused" : "live"}</span>
                  </button>
                ) : null}
                <span style={{ fontFamily: "var(--font-pixel)", fontSize: 13 }}>
                  64 × 64
                </span>
                <span>{"//"}</span>
                <span style={{ fontFamily: "var(--font-pixel)", fontSize: 13 }}>
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
              />
            </div>
          </div>

          {/* Side rail: target selector + connection status */}
          <aside className="flex flex-col gap-5 border-l border-dashed border-(--color-hairline) pl-4 lg:pl-6">
            <PanelSwitcher panelId={panelId} onChange={setChosenPanelId} />
            <div className="mt-auto flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.3em] text-(--color-text-faint)">
              <span>realtime</span>
              <LiveDot status={realtimeStatus} />
            </div>
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
              <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.3em]">
                <span className="text-(--color-text-dim)">:: messages</span>
                <span className="text-(--color-text-faint)">
                  top 7 fit on the matrix
                </span>
              </div>
              <EntriesList />
            </section>
          </div>
        ) : (
          <frame.Composer panelId={panelId} config={activeConfig} />
        )}
      </div>
    </PanelContext.Provider>
  );
}

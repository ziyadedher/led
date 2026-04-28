"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSWRConfig } from "swr";

import { Composer } from "@/app/components/Composer";
import { type ColorState } from "@/app/components/ColorPicker";
import {
  FORCE_ENABLE_MARQUEE_LENGTH,
  type EffectsState,
} from "@/app/components/EffectsPanel";
import { EntriesList } from "@/app/components/EntriesList";
import { LiveDot } from "@/app/components/LiveDot";
import { MatrixPreview } from "@/app/components/MatrixPreview";
import {
  isOffline,
  PanelSwitcher,
} from "@/app/components/PanelSwitcher";
import { PanelContext } from "@/app/context";
import {
  ClockComposer,
  clockFrameFromConfig,
  parseClockConfig,
} from "@/app/modes/clock";
import {
  LifeComposer,
  parseLifeConfig,
  useLifeFrame,
} from "@/app/modes/life";
import { ModeSwitcher } from "@/app/modes/ModeSwitcher";
import type { ModeFrame, TextEntry } from "@/app/modes/types";
import {
  entries,
  panels,
  type PanelMode,
  useRealtimeRevalidation,
} from "@/utils/actions";

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
  const panelId = chosenPanelId ?? defaultPanelId;
  const activePanel = panelsData?.find((p) => p.id === panelId);
  const activeMode: PanelMode =
    activePanel?.mode === "clock"
      ? "clock"
      : activePanel?.mode === "life"
        ? "life"
        : "text";

  // Tick `now` every 1s so the clock simulator advances and so the
  // offline indicator rolls over without a fresh data pull.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const activePanelOffline = isOffline(activePanel?.last_seen, now);

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

  const clockConfig = useMemo(
    () => parseClockConfig(activePanel?.mode_config),
    [activePanel?.mode_config],
  );
  const lifeConfig = useMemo(
    () => parseLifeConfig(activePanel?.mode_config),
    [activePanel?.mode_config],
  );

  // Life mode owns its own animation loop (rAF-driven cellular tick).
  // It always runs so we can preview the simulation regardless of
  // which mode is active — but we only feed it into the simulator
  // when life is the active mode.
  const lifeFrame = useLifeFrame(lifeConfig);

  // Build the ModeFrame the simulator should render. Text mode mixes
  // in the live composer preview; clock mode ticks current time on
  // each `now` change; life mode passes through its independent
  // simulation.
  const modeFrame = useModeFrame({
    mode: activeMode,
    panelId,
    message,
    color,
    marqueeSpeed: effectiveMarqueeSpeed,
    clockConfig,
    lifeFrame,
    now,
  });

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
              <Bracket pos="tl" />
              <Bracket pos="tr" />
              <Bracket pos="bl" />
              <Bracket pos="br" />
              <MatrixPreview offline={activePanelOffline} mode={modeFrame} />
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
        ) : activeMode === "clock" ? (
          <ClockComposer panelId={panelId} config={clockConfig} />
        ) : (
          <LifeComposer panelId={panelId} config={lifeConfig} />
        )}
      </div>
    </PanelContext.Provider>
  );
}

function useModeFrame({
  mode,
  message,
  color,
  marqueeSpeed,
  clockConfig,
  lifeFrame,
  now,
}: {
  mode: PanelMode;
  panelId: string;
  message: string;
  color: ColorState;
  marqueeSpeed: number;
  clockConfig: ReturnType<typeof parseClockConfig>;
  lifeFrame: ReturnType<typeof useLifeFrame>;
  now: number;
}): ModeFrame {
  return useMemo<ModeFrame>(() => {
    if (mode === "clock") {
      return { Clock: clockFrameFromConfig(clockConfig) };
    }
    if (mode === "life") {
      return { Life: lifeFrame };
    }
    // Text mode: live preview prepends to whatever's stored.
    const previewEntry: TextEntry | null =
      message.length > 0
        ? {
            text: message,
            options: {
              color:
                color.mode === "rgb"
                  ? { Rgb: color.rgb }
                  : {
                      Rainbow: {
                        is_per_letter: color.perLetter,
                        speed: color.speed,
                      },
                    },
              marquee: { speed: marqueeSpeed },
            },
          }
        : null;
    return {
      Text: {
        // EntriesList drives entry storage; MatrixPreview merges in
        // store-side entries via SWR. The frame here just carries the
        // live preview entry that hasn't been transmitted yet.
        entries: previewEntry ? [previewEntry] : [],
        scroll: 0,
      },
    };
    // `now` IS intentionally a dep — re-runs the memo every tick so
    // clock mode picks up the new ClockTime. eslint can't see the
    // dependency through clockFrameFromConfig's Date.now() read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, message, color, marqueeSpeed, clockConfig, lifeFrame, now]);
}

function Bracket({ pos }: { pos: "tl" | "tr" | "bl" | "br" }) {
  const sides: Record<string, string> = {
    tl: "-left-1.5 -top-1.5 border-l border-t",
    tr: "-right-1.5 -top-1.5 border-r border-t",
    bl: "-bottom-1.5 -left-1.5 border-b border-l",
    br: "-bottom-1.5 -right-1.5 border-b border-r",
  };
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute z-10 h-3 w-3 border-(--color-border-strong) ${sides[pos]}`}
    />
  );
}

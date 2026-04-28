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
import { PanelSwitcher } from "@/app/components/PanelSwitcher";
import { PanelContext } from "@/app/context";
import { entries, panels, useRealtimeRevalidation } from "@/utils/actions";

const AUTO_FORCED_DEFAULT = 10;

export default function Page() {
  const realtimeStatus = useRealtimeRevalidation();
  const { mutate } = useSWRConfig();
  const { data: panelsData } = panels.get.useSWR();

  const [chosenPanelId, setChosenPanelId] = useState<string | null>(null);
  const defaultPanelId = useMemo(() => {
    if (!panelsData || panelsData.length === 0) return "";
    return (
      panelsData.find((p) => p.name === "office")?.id ?? panelsData[0].id
    );
  }, [panelsData]);
  const panelId = chosenPanelId ?? defaultPanelId;
  const activePanel = panelsData?.find((p) => p.id === panelId);

  const [message, setMessage] = useState("");
  const [color, setColor] = useState<ColorState>({
    mode: "rgb",
    rgb: { r: 255, g: 138, b: 44 },
  });
  const [effects, setEffects] = useState<EffectsState>({ marqueeSpeed: 0 });

  const isSubmittable = message.length > 0 && panelId.length > 0;
  const isMarqueeForced = message.length >= FORCE_ENABLE_MARQUEE_LENGTH;

  // When the message crosses the auto-force threshold and the user
  // hasn't picked a speed, snap to a sensible default so the slider
  // visibly jumps and the preview matches what'll be transmitted.
  // Only fires on the upward crossing — once forced and snapped,
  // moving back below the threshold leaves the slider where it is.
  const wasForced = useRef(false);
  useEffect(() => {
    if (isMarqueeForced && !wasForced.current && effects.marqueeSpeed === 0) {
      setEffects((e) => ({ ...e, marqueeSpeed: AUTO_FORCED_DEFAULT }));
    }
    wasForced.current = isMarqueeForced;
  }, [isMarqueeForced, effects.marqueeSpeed]);

  // Effective marquee speed for preview + submit. The effect above
  // will snap the slider on the next render, but if the user types
  // and submits within the same render window we still want the
  // forced default applied.
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
    await mutate(`/entries/scroll/${panelId}`);
    await mutate(`/pause/${panelId}`);
  }, [color, message, mutate, panelId, effectiveMarqueeSpeed]);

  return (
    <PanelContext.Provider value={panelId}>
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 pb-16 pt-6 sm:px-6 lg:px-10">
        {/* ─── masthead ─────────────────────────────────────────── */}
        <header className="flex items-end justify-between gap-4 border-b border-dashed border-(--color-hairline) pb-4">
          <h1 className="flex items-baseline gap-2 font-mono text-2xl font-semibold leading-none tracking-tight sm:text-3xl">
            <span className="text-(--color-text-dim)">ziyad&apos;s</span>
            <span className="text-(--color-accent) drop-shadow-[0_0_14px_var(--color-accent-fade)]">
              led
            </span>
            <span className="text-(--color-text)">panels</span>
          </h1>
          <LiveDot status={realtimeStatus} />
        </header>

        {/* ─── instrument: matrix simulator ───────────────────────── */}
        <section
          className="grid gap-4 lg:grid-cols-[1fr_220px]"
          aria-label="Live simulator"
        >
          <div className="relative">
            {/* Instrument frame — corner brackets + heading bar above
             * the matrix. The MatrixPreview component itself draws the
             * black canvas + LEDs; we wrap it for the frame chrome. */}
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
              {/* Inner corner brackets */}
              <span
                aria-hidden
                className="pointer-events-none absolute -left-1.5 -top-1.5 z-10 h-3 w-3 border-l border-t border-(--color-border-strong)"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute -right-1.5 -top-1.5 z-10 h-3 w-3 border-r border-t border-(--color-border-strong)"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute -bottom-1.5 -left-1.5 z-10 h-3 w-3 border-b border-l border-(--color-border-strong)"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute -bottom-1.5 -right-1.5 z-10 h-3 w-3 border-b border-r border-(--color-border-strong)"
              />
              <MatrixPreview
                preview={{
                  text: message,
                  color,
                  marqueeSpeed: effectiveMarqueeSpeed,
                }}
              />
            </div>

            <div className="mt-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.3em] text-(--color-text-faint) tabular-nums">
              <span>signal · phosphor</span>
              <span className="flex items-center gap-2">
                <span className="inline-block h-1 w-1 animate-pulse rounded-[1px] bg-(--color-phosphor)" />
                live · rAF
              </span>
            </div>
          </div>

          {/* Side rail: panel selector + live preview readout */}
          <aside className="flex flex-col gap-5 border-l border-dashed border-(--color-hairline) pl-4 lg:pl-6">
            <PanelSwitcher panelId={panelId} onChange={setChosenPanelId} />

            <div className="border-t border-dashed border-(--color-hairline)" />

            <div className="space-y-1.5 font-mono text-[10px] uppercase tracking-[0.25em]">
              <div className="text-(--color-text-dim)">:: preview</div>
              <div className="text-(--color-text-faint)">
                len{" "}
                <span className="text-(--color-text) tabular-nums">
                  {String(message.length).padStart(2, "0")}
                </span>
              </div>
              <div className="text-(--color-text-faint)">
                mode{" "}
                <span className="text-(--color-text)">
                  {color.mode === "rgb" ? "rgb" : "rainbow"}
                </span>
              </div>
              <div className="text-(--color-text-faint)">
                marquee{" "}
                <span className="text-(--color-text) tabular-nums">
                  {String(effects.marqueeSpeed).padStart(2, "0")}
                </span>
              </div>
            </div>
          </aside>
        </section>

        {/* ─── composer + queue ──────────────────────────────────── */}
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
            aria-label="Queue"
          >
            <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.3em]">
              <span className="text-(--color-text-dim)">:: queue</span>
              <span className="text-(--color-text-faint)">
                fifo · top 7 on-air
              </span>
            </div>
            <EntriesList />
          </section>
        </div>

        {/* ─── footer hairline ──────────────────────────────────── */}
        <footer className="mt-auto flex items-center justify-between border-t border-dashed border-(--color-hairline) pt-3 font-mono text-[9px] uppercase tracking-[0.3em] text-(--color-text-faint)">
          <span>
            led.wall · v0.3 · panel{" "}
            <span className="text-(--color-text-dim)">
              {activePanel?.name ?? "—"}
            </span>
          </span>
          <span className="hidden sm:inline">
            press <span className="text-(--color-text-dim)">↵</span> to transmit
          </span>
        </footer>
      </div>
    </PanelContext.Provider>
  );
}


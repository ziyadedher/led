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
    return panelsData[0].id;
  }, [panelsData]);
  const panelId = chosenPanelId ?? defaultPanelId;

  const [message, setMessage] = useState("");
  const [color, setColor] = useState<ColorState>({
    mode: "rgb",
    rgb: { r: 255, g: 138, b: 44 },
  });
  const [effects, setEffects] = useState<EffectsState>({ marqueeSpeed: 0 });

  const isSubmittable = message.length > 0 && panelId.length > 0;
  const isMarqueeForced = message.length >= FORCE_ENABLE_MARQUEE_LENGTH;

  // Snap the marquee slider on the upward crossing of the auto-force
  // threshold so the UI shows what'll actually be transmitted.
  const wasForced = useRef(false);
  useEffect(() => {
    if (isMarqueeForced && !wasForced.current && effects.marqueeSpeed === 0) {
      setEffects((e) => ({ ...e, marqueeSpeed: AUTO_FORCED_DEFAULT }));
    }
    wasForced.current = isMarqueeForced;
  }, [isMarqueeForced, effects.marqueeSpeed]);

  // Effective speed for preview + submit, in case the user types and
  // submits within the same render before the snap effect fires.
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

          {/* Side rail: target selector + connection status */}
          <aside className="flex flex-col gap-5 border-l border-dashed border-(--color-hairline) pl-4 lg:pl-6">
            <PanelSwitcher panelId={panelId} onChange={setChosenPanelId} />
            <div className="mt-auto flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.3em] text-(--color-text-faint)">
              <span>realtime</span>
              <LiveDot status={realtimeStatus} />
            </div>
          </aside>
        </section>

        {/* ─── composer + messages ──────────────────────────────── */}
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
      </div>
    </PanelContext.Provider>
  );
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

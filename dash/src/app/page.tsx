"use client";

import { useCallback, useMemo, useState } from "react";
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

export default function Page() {
  useRealtimeRevalidation();
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

  const [message, setMessage] = useState("");
  const [color, setColor] = useState<ColorState>({
    mode: "rgb",
    rgb: { r: 255, g: 138, b: 44 },
  });
  const [effects, setEffects] = useState<EffectsState>({ marqueeSpeed: 0 });

  const isSubmittable = message.length > 0 && panelId.length > 0;

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
    const marqueeSpeed =
      effects.marqueeSpeed === 0 && message.length >= FORCE_ENABLE_MARQUEE_LENGTH
        ? 16
        : effects.marqueeSpeed;
    await entries.add.call(panelId, {
      text: message,
      options: {
        color: wireColor,
        marquee: { speed: marqueeSpeed },
      },
    });
    setMessage("");
    await mutate(`/entries/${panelId}`);
    await mutate(`/entries/scroll/${panelId}`);
    await mutate(`/pause/${panelId}`);
  }, [color, effects, message, mutate, panelId]);

  return (
    <PanelContext.Provider value={panelId}>
      <div className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-8 px-4 pb-16 pt-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
              led
            </span>
            <span className="font-mono text-2xl font-semibold tracking-tight">
              <span className="text-(--color-accent) [text-shadow:0_0_18px_var(--color-accent-fade)]">
                wall
              </span>
              <span className="text-(--color-text)">.</span>
            </span>
            <LiveDot />
          </div>
          <PanelSwitcher panelId={panelId} onChange={setChosenPanelId} />
        </header>

        <div className="flex justify-center">
          <div className="w-full max-w-md">
            <MatrixPreview
              preview={{
                text: message,
                color,
              }}
            />
          </div>
        </div>

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
          <section className="flex min-h-0 flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <h2 className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-dim)">
                queue
              </h2>
              <span className="font-mono text-[10px] text-(--color-text-dim)">
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

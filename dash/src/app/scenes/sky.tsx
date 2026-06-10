"use client";

import { useState } from "react";

import {
  DEFAULT_SKY_CONFIG,
  defaultSkyConfig,
  oneOf,
  SKY_FACES,
  type SkyFace,
  type SkyScene,
  type SkySceneConfig,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { ControlRow } from "@/app/components/ControlRow";
import { SegmentedToggle } from "@/app/components/SegmentedToggle";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { parseRgb } from "@/utils/color";
import { useComposerConfig } from "@/utils/useComposerConfig";

/** Read a stored mode_config jsonb back into a typed config. */
export function parseSkyConfig(raw: unknown): SkySceneConfig {
  if (!raw || typeof raw !== "object") return defaultSkyConfig();
  const obj = raw as Record<string, unknown>;
  const face = oneOf(obj.face, SKY_FACES, DEFAULT_SKY_CONFIG.face);
  const color = parseRgb(obj.color, DEFAULT_SKY_CONFIG.color);
  const lat =
    typeof obj.lat === "number" && Number.isFinite(obj.lat)
      ? Math.max(-90, Math.min(90, obj.lat))
      : DEFAULT_SKY_CONFIG.lat;
  const lon =
    typeof obj.lon === "number" && Number.isFinite(obj.lon)
      ? Math.max(-180, Math.min(180, obj.lon))
      : DEFAULT_SKY_CONFIG.lon;
  return { face, lat, lon, color };
}

/** Build the render frame: config + the current UTC sample (the Rust
 * sky math is UTC-based; the driver injects chrono::Utc the same way). */
export function skySceneFromConfig(config: SkySceneConfig): SkyScene {
  const d = new Date();
  return {
    ...config,
    now: {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
    },
  };
}

const FACE_OPTIONS: { id: SkyFace; label: string; blurb?: string }[] = [
  { id: "Moon", label: "moon", blurb: "tonight's phase" },
  { id: "Sun", label: "sun", blurb: "today's solar arc" },
  { id: "Terminator", label: "earth", blurb: "day/night terminator map" },
];

const FACE_STATUS: Record<SkyFace, string> = {
  Moon: "moon phase",
  Sun: "solar day arc",
  Terminator: "day/night terminator",
};

/**
 * Composer for sky mode: face toggle, observer coordinates, accent
 * color. The astronomy itself (phase, declination, equation of time)
 * is computed in the renderer from an injected UTC sample — nothing
 * here ever touches the network.
 */
export function SkyComposer({ panelId, config }: { panelId: string; config: SkySceneConfig }) {
  const [draft, update] = useComposerConfig<SkySceneConfig>(panelId, "sky", config);

  return (
    <ComposerShell
      title="sky"
      status={FACE_STATUS[draft.face]}
      ariaLabel="Sky configuration"
    >
      <ControlRow label="face">
        <SegmentedToggle<SkyFace>
          ariaLabel="Sky face"
          options={FACE_OPTIONS}
          value={draft.face}
          onChange={(face) => update({ ...draft, face })}
        />
      </ControlRow>

      <div className="border-t border-dashed border-(--color-hairline)" />

      <ControlRow label="observer">
        <div className="flex items-center gap-3">
          <CoordInput
            label="lat"
            value={draft.lat}
            min={-90}
            max={90}
            onCommit={(lat) => update({ ...draft, lat })}
          />
          <CoordInput
            label="lon"
            value={draft.lon}
            min={-180}
            max={180}
            onCommit={(lon) => update({ ...draft, lon })}
          />
        </div>
      </ControlRow>
      <p className="font-mono text-[9px] tracking-wide text-(--color-text-faint)">
        set your coordinates — everything is computed locally, no network
      </p>

      <div className="border-t border-dashed border-(--color-hairline)" />

      <SolidColorPicker
        value={draft.color}
        onChange={(color) => update({ ...draft, color })}
      />
    </ComposerShell>
  );
}

/**
 * One observer coordinate. Keeps a draft string so partial typing
 * ("-12" on the way to "-122.4") never fights the server echo — same
 * commit-on-blur/Enter contract as SolidColorPicker's hex field.
 * Out-of-range commits clamp; unparseable drafts snap back.
 */
function CoordInput({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (next: number) => void;
}) {
  const valueText = String(value);
  const [draft, setDraft] = useState(valueText);
  const [snapshot, setSnapshot] = useState(valueText);
  if (snapshot !== valueText) {
    setSnapshot(valueText);
    setDraft(valueText);
  }

  const commit = () => {
    const n = Number(draft);
    if (draft.trim().length > 0 && Number.isFinite(n)) {
      // Round to 0.1° (the input's step) and clamp to the wire range.
      onCommit(Math.max(min, Math.min(max, Math.round(n * 10) / 10)));
    } else {
      setDraft(valueText);
    }
  };

  return (
    <label className="flex items-center gap-1.5">
      <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-(--color-text-faint)">
        {label}
      </span>
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={0.1}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        spellCheck={false}
        autoComplete="off"
        inputMode="decimal"
        aria-label={`Observer ${label === "lat" ? "latitude" : "longitude"} in degrees`}
        className="w-20 border border-(--color-border) bg-(--color-surface-2) px-2 py-1 text-right font-mono text-[10px] tabular-nums text-(--color-text) focus:border-(--color-accent) focus:outline-none"
      />
    </label>
  );
}

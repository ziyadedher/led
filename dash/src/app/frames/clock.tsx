"use client";

import { useState } from "react";

import {
  type ClockModeConfig,
  type ClockModeFrame,
  DEFAULT_CLOCK_CONFIG,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { HexColorInput } from "@/app/components/HexColorInput";
import { panels } from "@/utils/actions";

/** Build a renderable clock frame from saved config + current time. */
export function clockFrameFromConfig(config: ClockModeConfig): ClockModeFrame {
  const { hour, minute, second } = sampleTime(config.timezone);
  return {
    format: config.format,
    show_seconds: config.show_seconds,
    show_meridiem: config.show_meridiem,
    color: config.color,
    now: { hour, minute, second },
  };
}

/**
 * Sample wall-clock time honouring an IANA timezone if one is set.
 * Falls back to the browser's local time when missing/invalid.
 */
function sampleTime(timezone: string | null) {
  const d = new Date();
  if (!timezone) {
    return { hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(d).map((p) => [p.type, p.value]),
    );
    const hour = Number(parts.hour ?? "0") % 24;
    return {
      hour,
      minute: Number(parts.minute ?? "0"),
      second: Number(parts.second ?? "0"),
    };
  } catch {
    return { hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
  }
}

/** Read a stored mode_config jsonb back into a typed `ClockModeConfig`. */
export function parseClockConfig(raw: unknown): ClockModeConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_CLOCK_CONFIG;
  const obj = raw as Record<string, unknown>;
  const fmt = obj.format === "H12" ? "H12" : "H24";
  const colorRaw =
    obj.color && typeof obj.color === "object"
      ? (obj.color as Record<string, unknown>)
      : null;
  const color = colorRaw
    ? {
        r: clamp255(colorRaw.r),
        g: clamp255(colorRaw.g),
        b: clamp255(colorRaw.b),
      }
    : DEFAULT_CLOCK_CONFIG.color;
  const timezone =
    typeof obj.timezone === "string" && obj.timezone.length > 0
      ? obj.timezone
      : null;
  return {
    format: fmt,
    show_seconds: Boolean(obj.show_seconds),
    show_meridiem: Boolean(obj.show_meridiem),
    timezone,
    color,
  };
}

function clamp255(n: unknown): number {
  const v = typeof n === "number" ? n : 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Composer-side configuration for clock mode. Drag the dials, see
 * the simulator above tick the new format. Optimistic local state;
 * persisted to Supabase on a small debounce.
 */
export function ClockComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: ClockModeConfig;
}) {
  // Hold an optimistic local copy so the form doesn't snap when an
  // unrelated panel field updates (last_seen ticks every 30s). When
  // the server-side config bytes change, sync down. Computed during
  // render avoids the setState-in-effect anti-pattern.
  const configKey = JSON.stringify(config);
  const [snapshotKey, setSnapshotKey] = useState(configKey);
  const [local, setLocal] = useState<ClockModeConfig>(config);
  if (snapshotKey !== configKey) {
    setSnapshotKey(configKey);
    setLocal(config);
  }

  const persist = (next: ClockModeConfig) => {
    setLocal(next);
    void panels.setMode.call(panelId, "clock", next);
  };

  return (
    <ComposerShell title="clock" status="local time" ariaLabel="Clock configuration">
      <div className="space-y-5 px-4 py-4">
        <Row label="format">
          <SegmentedToggle
            options={[
              { id: "H24", label: "24h" },
              { id: "H12", label: "12h" },
            ]}
            value={local.format}
            onChange={(v) => persist({ ...local, format: v as "H12" | "H24" })}
          />
        </Row>

        <Row label="seconds">
          <SegmentedToggle
            options={[
              { id: "off", label: "off" },
              { id: "on", label: "on" },
            ]}
            value={local.show_seconds ? "on" : "off"}
            onChange={(v) => persist({ ...local, show_seconds: v === "on" })}
          />
        </Row>

        {local.format === "H12" ? (
          <Row label="meridiem">
            <SegmentedToggle
              options={[
                { id: "off", label: "hidden" },
                { id: "on", label: "a/p" },
              ]}
              value={local.show_meridiem ? "on" : "off"}
              onChange={(v) =>
                persist({ ...local, show_meridiem: v === "on" })
              }
            />
          </Row>
        ) : null}

        <Row label="timezone">
          <TimezoneSelect
            value={local.timezone}
            onChange={(next) => persist({ ...local, timezone: next })}
          />
        </Row>

        <Row label="hex">
          <HexColorInput
            value={local.color}
            onChange={(next) => persist({ ...local, color: next })}
          />
        </Row>
      </div>
    </ComposerShell>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
        :: {label}
      </span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

/**
 * IANA-timezone dropdown. Uses `Intl.supportedValuesOf("timeZone")`
 * (available in modern browsers); the empty value means "follow Pi
 * system local time".
 */
function TimezoneSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const options =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [
          "UTC",
          "America/Los_Angeles",
          "America/New_York",
          "Europe/London",
          "Europe/Paris",
          "Asia/Tokyo",
          "Australia/Sydney",
        ];
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="border border-(--color-border) bg-(--color-surface-2) px-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text) focus:border-(--color-accent) focus:outline-none"
    >
      <option value="">auto (system local)</option>
      {options.map((tz) => (
        <option key={tz} value={tz}>
          {tz}
        </option>
      ))}
    </select>
  );
}

function SegmentedToggle({
  options,
  value,
  onChange,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-px border border-(--color-border)">
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={[
              "px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] transition-colors",
              active
                ? "bg-(--color-accent) text-black"
                : "text-(--color-text-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)",
            ].join(" ")}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}


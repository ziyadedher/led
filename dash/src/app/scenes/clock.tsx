"use client";

import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from "@headlessui/react";
import { useMemo, useState } from "react";

import {
  type ClockSceneConfig,
  type ClockScene,
  DEFAULT_CLOCK_CONFIG,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { SolidColorPicker } from "@/app/components/SolidColorPicker";
import { useDebouncedSetMode } from "@/utils/useDebouncedSetMode";

/** Build a renderable clock frame from saved config + current time. */
export function clockSceneFromConfig(config: ClockSceneConfig): ClockScene {
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

/** Read a stored mode_config jsonb back into a typed `ClockSceneConfig`. */
export function parseClockConfig(raw: unknown): ClockSceneConfig {
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
  config: ClockSceneConfig;
}) {
  // Hold an optimistic local copy so the form doesn't snap when an
  // unrelated panel field updates (last_seen ticks every 30s). When
  // the server-side config bytes change, sync down. Computed during
  // render avoids the setState-in-effect anti-pattern.
  const configKey = JSON.stringify(config);
  const [snapshotKey, setSnapshotKey] = useState(configKey);
  const [local, setLocal] = useState<ClockSceneConfig>(config);
  if (snapshotKey !== configKey) {
    setSnapshotKey(configKey);
    setLocal(config);
  }

  const [pushDebounced] = useDebouncedSetMode<ClockSceneConfig>(
    panelId,
    "clock",
  );
  const persist = (next: ClockSceneConfig) => {
    setLocal(next);
    pushDebounced(next);
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

        <SolidColorPicker
          value={local.color}
          onChange={(next) => persist({ ...local, color: next })}
        />
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

const AUTO_VALUE = "__AUTO__";

/**
 * Searchable IANA-timezone combobox. ~600 zones via
 * `Intl.supportedValuesOf("timeZone")` is too many for a native
 * dropdown; this filters as you type. Empty value (`__AUTO__`)
 * means "follow Pi system local time".
 */
function TimezoneSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const options = useMemo<string[]>(
    () =>
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
          ],
    [],
  );

  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    if (query.length === 0) return options.slice(0, 50);
    const q = query.toLowerCase();
    return options.filter((tz) => tz.toLowerCase().includes(q)).slice(0, 50);
  }, [options, query]);

  const display = value === null ? "auto · system local" : value;

  return (
    <Combobox
      value={value ?? AUTO_VALUE}
      onChange={(v: string | null) => onChange(v === AUTO_VALUE || !v ? null : v)}
      immediate
    >
      <div className="relative w-56">
        <ComboboxInput
          aria-label="Timezone"
          displayValue={() => display}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full border border-(--color-border) bg-(--color-surface-2) px-2 py-1 pr-6 font-mono text-[10px] tracking-[0.1em] text-(--color-text) focus:border-(--color-accent) focus:outline-none"
          spellCheck={false}
        />
        <ComboboxButton
          aria-label="Toggle timezone list"
          className="absolute inset-y-0 right-0 flex items-center px-1.5 text-(--color-text-faint) hover:text-(--color-text)"
        >
          <span aria-hidden style={{ fontFamily: "var(--font-pixel)", fontSize: 10 }}>
            ▾
          </span>
        </ComboboxButton>
        <ComboboxOptions className="absolute z-10 mt-1 max-h-60 w-full overflow-auto border border-(--color-border-strong) bg-(--color-bg) py-1 shadow-lg">
          <ComboboxOption
            value={AUTO_VALUE}
            className="cursor-pointer px-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint) data-[focus]:bg-(--color-accent)/15 data-[focus]:text-(--color-accent)"
          >
            auto · system local
          </ComboboxOption>
          {filtered.map((tz) => (
            <ComboboxOption
              key={tz}
              value={tz}
              className="cursor-pointer px-2 py-1 font-mono text-[10px] tracking-[0.05em] text-(--color-text-muted) data-[focus]:bg-(--color-accent)/15 data-[focus]:text-(--color-accent) data-[selected]:text-(--color-accent)"
            >
              {tz}
            </ComboboxOption>
          ))}
          {filtered.length === 0 ? (
            <div className="px-2 py-1 font-mono text-[10px] text-(--color-text-faint)">
              no match
            </div>
          ) : null}
        </ComboboxOptions>
      </div>
    </Combobox>
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


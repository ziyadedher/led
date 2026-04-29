"use client";

import { parseGIF, decompressFrames, type ParsedFrame } from "gifuct-js";
import { useRef, useState } from "react";

import {
  DEFAULT_GIF_CONFIG,
  type GifFrame,
  type GifSceneConfig,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { panels } from "@/utils/actions";

const PANEL_W = 64;
const PANEL_H = 64;
// Hard cap on frames. A 60-frame GIF stored as RGB888 number[] is
// ~720KB of JSON which Supabase and our jsonb column can still
// handle, but anything larger than ~120 starts running into update
// latency. If the source has more, we drop the tail.
const MAX_FRAMES = 60;
// Floor on per-frame delay — gifs sometimes ship 0ms which would
// pin the decoder/renderer to a single frame.
const MIN_DELAY_MS = 20;

export function parseGifConfig(raw: unknown): GifSceneConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_GIF_CONFIG;
  const obj = raw as Record<string, unknown>;
  const width = typeof obj.width === "number" ? obj.width : 0;
  const height = typeof obj.height === "number" ? obj.height : 0;
  const framesRaw = Array.isArray(obj.frames) ? obj.frames : [];
  const expectedLen = width * height * 3;
  const frames: GifFrame[] = [];
  for (const f of framesRaw) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const bitmap = Array.isArray(o.bitmap) ? (o.bitmap as number[]) : null;
    const delay = typeof o.delay_ms === "number" ? o.delay_ms : 0;
    if (!bitmap || bitmap.length !== expectedLen) continue;
    frames.push({ bitmap, delay_ms: Math.max(MIN_DELAY_MS, delay) });
  }
  if (width <= 0 || height <= 0 || frames.length === 0) {
    return DEFAULT_GIF_CONFIG;
  }
  const speed =
    typeof obj.speed === "number" && obj.speed > 0
      ? Math.max(0.05, Math.min(16, obj.speed))
      : 1;
  const source = typeof obj.source === "string" ? obj.source : undefined;
  const source_frame_count =
    typeof obj.source_frame_count === "number"
      ? obj.source_frame_count
      : undefined;
  return { width, height, frames, speed, source, source_frame_count };
}

/**
 * Decode an uploaded GIF into a sequence of fixed-size RGB888 frames.
 * gifuct-js gives us patches per frame plus disposal/dims metadata;
 * we composite onto a working canvas to resolve disposal correctly,
 * downsample to PANEL_W × PANEL_H (centered, fit), then snapshot.
 */
async function decodeGif(file: File): Promise<GifSceneConfig> {
  const buf = await file.arrayBuffer();
  const gif = parseGIF(buf);
  const parsed: ParsedFrame[] = decompressFrames(gif, true);
  if (parsed.length === 0) {
    throw new Error("gif had no frames");
  }

  const lsd = gif.lsd;
  // Working canvas at native gif size — gifuct frames are patches
  // referencing a logical-screen-sized buffer. We composite into
  // here, then downsample to the panel.
  const work = document.createElement("canvas");
  work.width = lsd.width;
  work.height = lsd.height;
  const wctx = work.getContext("2d");
  if (!wctx) throw new Error("no 2d context");
  // Start fully transparent — gifuct's first frame may rely on
  // background-color disposal which leaves prior pixels in place.
  wctx.clearRect(0, 0, work.width, work.height);

  // Down-sample target.
  const ratio = Math.min(PANEL_W / lsd.width, PANEL_H / lsd.height);
  const drawW = Math.max(1, Math.round(lsd.width * ratio));
  const drawH = Math.max(1, Math.round(lsd.height * ratio));
  const out = document.createElement("canvas");
  out.width = drawW;
  out.height = drawH;
  const octx = out.getContext("2d");
  if (!octx) throw new Error("no 2d context");
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";

  const frames: GifFrame[] = [];
  let prevImage: ImageData | null = null;

  const limit = Math.min(parsed.length, MAX_FRAMES);
  for (let fi = 0; fi < limit; fi++) {
    const frame = parsed[fi];

    // Apply disposal of the *previous* frame before drawing this one.
    if (prevImage && fi > 0) {
      const prev = parsed[fi - 1];
      if (prev.disposalType === 2) {
        // Restore to background = clear that frame's region.
        const d = prev.dims;
        wctx.clearRect(d.left, d.top, d.width, d.height);
      } else if (prev.disposalType === 3) {
        // Restore to previous: paint back what was there before.
        wctx.putImageData(prevImage, 0, 0);
      }
      // disposal 0/1: leave in place.
    }

    // Snapshot the working buffer *before* drawing this frame's
    // patch — needed for "restore to previous" disposal handling on
    // the next iteration.
    prevImage = wctx.getImageData(0, 0, work.width, work.height);

    // Paint this frame's patch.
    const patch = new ImageData(
      new Uint8ClampedArray(frame.patch),
      frame.dims.width,
      frame.dims.height,
    );
    // putImageData ignores transparency from the patch — gifuct's
    // patch is already pre-multiplied, so transparent pixels come
    // through as alpha=0 which is what we want for compositing.
    // The simplest path: draw via a temp canvas.
    const patchCanvas = document.createElement("canvas");
    patchCanvas.width = frame.dims.width;
    patchCanvas.height = frame.dims.height;
    const pctx = patchCanvas.getContext("2d");
    if (!pctx) throw new Error("no 2d context");
    pctx.putImageData(patch, 0, 0);
    wctx.drawImage(patchCanvas, frame.dims.left, frame.dims.top);

    // Downsample to panel size.
    octx.clearRect(0, 0, drawW, drawH);
    octx.drawImage(work, 0, 0, drawW, drawH);
    const data = octx.getImageData(0, 0, drawW, drawH).data;

    const bitmap = new Array<number>(drawW * drawH * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      bitmap[j] = data[i];
      bitmap[j + 1] = data[i + 1];
      bitmap[j + 2] = data[i + 2];
    }
    // Per-frame delay: gifuct returns delay in 1/100s units.
    const delay_ms = Math.max(MIN_DELAY_MS, (frame.delay ?? 10) * 10);
    frames.push({ bitmap, delay_ms });
  }

  return {
    width: drawW,
    height: drawH,
    frames,
    speed: 1,
    source: file.name,
    source_frame_count: parsed.length,
  };
}

// Speed presets. Slider snaps to these; arbitrary values are still
// clamped server-side at render time.
const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4];

export function GifComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: GifSceneConfig;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setBusy(true);
    setErr(null);
    try {
      const next = await decodeGif(file);
      await panels.setMode.call(panelId, "gif", next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setSpeed = (next: number) => {
    if (config.frames.length === 0) return;
    void panels.setMode.call(panelId, "gif", { ...config, speed: next });
  };

  const hasFrames = config.frames.length > 0;
  const trimmed =
    config.source_frame_count != null &&
    config.source_frame_count > config.frames.length;

  // Total looped duration for the diagnostic readout — accounts for
  // the playback speed the user has dialed in.
  const totalMs = config.frames.reduce((acc, f) => acc + f.delay_ms, 0);
  const effectiveLoopMs = totalMs / Math.max(0.05, config.speed);

  return (
    <ComposerShell
      title="gif"
      status={`max ${MAX_FRAMES} frames · 64×64`}
      ariaLabel="GIF configuration"
    >
      <div className="space-y-5 px-4 pb-5 pt-5">
        <div>
          <div className="mb-7 font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
            :: upload
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              className="border border-(--color-accent)/60 bg-(--color-accent)/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.3em] text-(--color-accent) transition hover:bg-(--color-accent)/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "decoding…" : "choose .gif"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/gif"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
                e.target.value = "";
              }}
            />
            {hasFrames ? (
              <span className="truncate font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-text-faint)">
                {config.source ?? "uploaded"} · {config.width}×{config.height}
              </span>
            ) : (
              <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-text-faint)">
                no gif loaded
              </span>
            )}
          </div>
        </div>

        {err ? (
          <div className="border border-(--color-danger)/40 bg-(--color-danger)/5 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-danger)">
            err: {err}
          </div>
        ) : null}

        {hasFrames ? (
          <>
            <div className="border-t border-dashed border-(--color-hairline)" />

            <SpeedRow value={config.speed} onChange={setSpeed} />

            <div className="border-t border-dashed border-(--color-hairline)" />

            <div className="grid grid-cols-2 gap-px border border-(--color-border) bg-(--color-border) sm:grid-cols-4">
              <Stat label="frames" value={pad(config.frames.length, 2)} />
              <Stat
                label="loop"
                value={`${(effectiveLoopMs / 1000).toFixed(2)}s`}
              />
              <Stat
                label="speed"
                value={`${config.speed.toFixed(2)}x`}
                tone={config.speed === 1 ? undefined : "warn"}
              />
              <Stat
                label="source"
                value={
                  trimmed
                    ? `${config.frames.length}/${config.source_frame_count}`
                    : "full"
                }
                tone={trimmed ? "warn" : "ok"}
              />
            </div>
          </>
        ) : null}
      </div>
    </ComposerShell>
  );
}

function SpeedRow({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  // Min slider step so dragging feels smooth; presets are markers.
  const min = SPEED_PRESETS[0];
  const max = SPEED_PRESETS[SPEED_PRESETS.length - 1];
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
          {"// speed"}
        </span>
        <span
          className="tabular-nums text-(--color-text)"
          style={{ fontFamily: "var(--font-pixel)", fontSize: 14 }}
        >
          {value.toFixed(2)}x
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
          slow
        </span>
        <input
          type="range"
          min={min}
          max={max}
          step={0.05}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="fader flex-1"
          style={{ ["--fader-pos" as string]: `${pct}%` } as React.CSSProperties}
          aria-label="GIF speed"
        />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-text-faint)">
          fast
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {SPEED_PRESETS.map((p) => {
          const active = Math.abs(value - p) < 0.01;
          return (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              className={[
                "border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.25em] transition-colors",
                active
                  ? "border-(--color-accent) bg-(--color-accent)/15 text-(--color-accent)"
                  : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong) hover:text-(--color-text)",
              ].join(" ")}
            >
              {p}x
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}) {
  const valueClass =
    tone === "warn"
      ? "text-(--color-amber)"
      : tone === "ok"
        ? "text-(--color-phosphor)"
        : "text-(--color-text)";
  return (
    <div className="flex flex-col gap-0.5 bg-(--color-surface)/50 px-3 py-2">
      <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-(--color-text-dim)">
        {label}
      </span>
      <span
        className={`tabular-nums ${valueClass}`}
        style={{ fontFamily: "var(--font-pixel)", fontSize: 14 }}
      >
        {value}
      </span>
    </div>
  );
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

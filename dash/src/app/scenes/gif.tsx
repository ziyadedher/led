"use client";

import { parseGIF, decompressFrames, type ParsedFrame } from "gifuct-js";
import { useState } from "react";

import {
  defaultGifConfig,
  type GifFrame,
  type GifSceneConfig,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { Fader } from "@/app/components/Fader";
import { UploadRow } from "@/app/components/UploadRow";
import { Alert, PixelValue } from "@/app/components/ui";
import { panels } from "@/utils/actions";
import { pad } from "@/utils/format";
import { useDebouncedSetMode } from "@/utils/useDebouncedSetMode";
import { useSyncedFromProp } from "@/utils/useSyncedFromProp";

const PANEL_W = 64;
const PANEL_H = 64;
// Cap frame count: each frame is ~16KB of RGBA bytes and the whole
// payload is JSON-stringified into mode_config, so Supabase write
// latency climbs roughly linearly with frame count past this point.
const MAX_FRAMES = 60;
// Defensive floor — some gifs ship 0ms delays.
const MIN_DELAY_MS = 20;

export function parseGifConfig(raw: unknown): GifSceneConfig {
  if (!raw || typeof raw !== "object") return defaultGifConfig();
  const obj = raw as Record<string, unknown>;
  const width = typeof obj.width === "number" ? obj.width : 0;
  const height = typeof obj.height === "number" ? obj.height : 0;
  const framesRaw = Array.isArray(obj.frames) ? obj.frames : [];
  // RGBA, 4-byte stride: each frame's bitmap is exactly 4 * w * h
  // (matches display_core::frames::gif::GifFrame).
  const expectedLen = width * height * 4;
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
    return defaultGifConfig();
  }
  // Clamp uniformly to the driver's render range [0.05, 16]; only a
  // missing/non-numeric speed falls back to 1. A stored 0 clamps up
  // to the slider floor (0.05), consistent with the driver's clamp.
  const speed =
    typeof obj.speed === "number"
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
 * Decode an uploaded GIF into a sequence of fixed-size RGBA frames
 * (4-byte stride; what the Rust/WASM renderer expects). gifuct-js
 * gives us patches per frame plus disposal/dims metadata; we
 * composite onto a working canvas to resolve disposal correctly,
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
  // Snapshot of the working canvas taken immediately BEFORE the
  // previous frame's patch was drawn. GIF disposal method 3
  // ("restore to previous") requires reverting to exactly that state
  // — NOT to a rolling buffer that already has the previous frame's
  // pixels composited in (which drifts on chained type-3 frames).
  let preDrawSnapshot: ImageData | null = null;

  const limit = Math.min(parsed.length, MAX_FRAMES);
  for (let fi = 0; fi < limit; fi++) {
    const frame = parsed[fi];

    // Apply disposal of the *previous* frame before drawing this one.
    if (fi > 0) {
      const prev = parsed[fi - 1];
      if (prev.disposalType === 2) {
        // Restore to background = clear that frame's region.
        const d = prev.dims;
        wctx.clearRect(d.left, d.top, d.width, d.height);
      } else if (prev.disposalType === 3 && preDrawSnapshot) {
        // Restore to previous: revert the whole canvas to the state
        // captured right before the previous frame was drawn.
        wctx.putImageData(preDrawSnapshot, 0, 0);
      }
      // disposal 0/1: leave in place.
    }

    // Snapshot the working buffer *before* drawing this frame's
    // patch — this is the state a following frame with disposal
    // type 3 ("restore to previous") must revert to.
    preDrawSnapshot = wctx.getImageData(0, 0, work.width, work.height);

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

    // Downsample to panel size. ImageData is RGBA already; the
    // working canvas's transparent areas (gif disposal-to-background
    // regions) come through as alpha=0, which the renderer treats
    // as transparent on the LED matrix.
    octx.clearRect(0, 0, drawW, drawH);
    octx.drawImage(work, 0, 0, drawW, drawH);
    const data = octx.getImageData(0, 0, drawW, drawH).data;

    // Bulk-copy the RGBA Uint8ClampedArray; Array.from is far faster
    // than a per-byte assignment loop over ~16K elements per frame.
    const bitmap = Array.from(data);
    // Per-frame delay: gifuct already converts the GIF's 1/100s units
    // to milliseconds (and substitutes 100ms for a missing delay).
    const delay_ms = Math.max(MIN_DELAY_MS, frame.delay ?? 100);
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
  // "decode" is CPU-bound canvas work; "transmit" is the multi-second
  // ~720KB Supabase write. Splitting the label keeps the long second
  // phase from reading as a hung decode.
  const [phase, setPhase] = useState<"decode" | "transmit" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Local draft of the speed so the fader/readouts respond instantly:
  // binding straight to `config.speed` lets the 1Hz page re-render
  // yank the thumb back mid-drag until the realtime echo lands.
  const [draftSpeed, setDraftSpeed] = useSyncedFromProp(
    `${panelId}:gif`,
    config.speed,
  );

  // Speed slider goes through the debounced path so a drag doesn't
  // ship the entire (~720KB) frame payload to Supabase per
  // intermediate value. File upload stays a direct call — upload is
  // a single user gesture that shouldn't queue.
  const speedWriter = useDebouncedSetMode<GifSceneConfig>(panelId, "gif");

  const handleFile = async (file: File) => {
    setPhase("decode");
    setErr(null);
    try {
      // Drop any staged speed write (the new file's decoded config
      // supersedes it), then wait out any write already in flight —
      // a slow speed write landing AFTER the upload's setMode would
      // clobber the new gif with the old gif's frames.
      speedWriter.cancel();
      await speedWriter.settle();
      const next = await decodeGif(file);
      setPhase("transmit");
      await panels.setMode.call(panelId, "gif", next);
      // The decoded config resets speed to 1, but the draft's key
      // (panelId:gif) doesn't change on upload — reset it manually so
      // the fader doesn't keep showing the old gif's speed.
      setDraftSpeed(1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase(null);
    }
  };

  const setSpeed = (next: number) => {
    if (config.frames.length === 0) return;
    setDraftSpeed(next);
    speedWriter.push({ ...config, speed: next });
  };

  const hasFrames = config.frames.length > 0;
  const trimmed =
    config.source_frame_count != null &&
    config.source_frame_count > config.frames.length;

  // Total looped duration for the diagnostic readout — accounts for
  // the playback speed the user has dialed in (draft, so the stat
  // tracks the fader instead of lagging until the server echo).
  const totalMs = config.frames.reduce((acc, f) => acc + f.delay_ms, 0);
  const effectiveLoopMs = totalMs / Math.max(0.05, draftSpeed);

  return (
    <ComposerShell
      title="gif"
      status={`max ${MAX_FRAMES} frames · 64×64`}
      ariaLabel="GIF configuration"
    >
      <UploadRow
        accept="image/gif"
        idleLabel="choose .gif"
        busyLabel={phase === "transmit" ? "transmitting…" : "decoding…"}
        busy={phase != null}
        status={
          hasFrames
            ? `${config.source ?? "uploaded"} · ${config.width}×${config.height}`
            : "no gif loaded"
        }
        onFile={(file) => void handleFile(file)}
      />

      {err ? <Alert>err: {err}</Alert> : null}

      {hasFrames ? (
        <>
          <div className="border-t border-dashed border-(--color-hairline)" />

          <Fader
            label="speed"
            value={draftSpeed}
            min={SPEED_PRESETS[0]}
            max={SPEED_PRESETS[SPEED_PRESETS.length - 1]}
            step={0.05}
            onChange={setSpeed}
            format={(v) => `${v.toFixed(2)}x`}
            endpoints={["slow", "fast"]}
            presets={SPEED_PRESETS}
            presetLabel={(v) => `${v}x`}
            ariaLabel="GIF speed"
          />

          <div className="border-t border-dashed border-(--color-hairline)" />

          <div className="grid grid-cols-2 gap-px border border-(--color-border) bg-(--color-border) sm:grid-cols-4">
            <Stat label="frames" value={pad(config.frames.length, 2)} />
            <Stat
              label="loop"
              value={`${(effectiveLoopMs / 1000).toFixed(2)}s`}
            />
            <Stat
              label="speed"
              value={`${draftSpeed.toFixed(2)}x`}
              tone={draftSpeed === 1 ? undefined : "warn"}
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
    </ComposerShell>
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
      <PixelValue size="md" className={valueClass}>
        {value}
      </PixelValue>
    </div>
  );
}

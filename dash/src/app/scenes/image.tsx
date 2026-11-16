"use client";

import { useState } from "react";

import {
  defaultImageConfig,
  type ImageSceneConfig,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import {
  AdjustCropButton,
  CropEditor,
  type CropSource,
} from "@/app/components/CropEditor";
import { UploadRow } from "@/app/components/UploadRow";
import { Alert } from "@/app/components/ui";
import { panels } from "@/utils/actions";
import {
  PANEL_H,
  PANEL_W,
  centeredBounds,
  drawCrop,
  makePanelCanvas,
  sliceBounds,
  type CropTransform,
} from "@/utils/crop";

const STILL_MAX_SIDE = 2048;

export function parseImageConfig(raw: unknown): ImageSceneConfig {
  if (!raw || typeof raw !== "object") return defaultImageConfig();
  const obj = raw as Record<string, unknown>;
  const width = typeof obj.width === "number" ? obj.width : 0;
  const height = typeof obj.height === "number" ? obj.height : 0;
  const bitmap = Array.isArray(obj.bitmap) ? (obj.bitmap as number[]) : [];
  const source = typeof obj.source === "string" ? obj.source : undefined;
  // RGBA, 4-byte stride: length must be exactly 4 * width * height
  // (matches display_core::frames::image::ImageScene).
  if (bitmap.length === 0 || bitmap.length !== width * height * 4) {
    return defaultImageConfig();
  }
  return { width, height, bitmap, source };
}

/**
 * Render a still through the editor's crop transform and pack the
 * result as RGBA row-major bytes (4-byte stride). The Rust/WASM
 * renderer treats alpha as binary — any non-zero alpha renders at
 * full intensity, alpha 0 leaves the LED unset — and centres
 * whatever width×height it gets, so the transparent margin is trimmed
 * symmetrically (an untouched "fit" crop ships the same 64×N block
 * the old fit-and-centre path did).
 */
function cropStill(
  source: CropSource,
  t: CropTransform,
  name: string,
): ImageSceneConfig {
  const { ctx } = makePanelCanvas();
  drawCrop(ctx, source.frames[0].image, source.width, source.height, t);
  const data = ctx.getImageData(0, 0, PANEL_W, PANEL_H).data;
  const b = centeredBounds([data]);
  return {
    width: b.width,
    height: b.height,
    bitmap: sliceBounds(data, b),
    source: name,
  };
}

async function loadStill(file: File): Promise<CropSource> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
      throw new Error("image has no pixels");
    }
    // Rasterise once into a canvas we own: the blob URL is revoked
    // below (an <img> whose decoded copy gets evicted would then go
    // blank on some mobile browsers), and capping the long side keeps
    // a 12MP phone photo from pinning ~50MB while the editor is open.
    // 2048px is still 32× a 64px fit — more zoom than the panel needs.
    const shrink = Math.min(
      1,
      STILL_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight),
    );
    const width = Math.max(1, Math.round(img.naturalWidth * shrink));
    const height = Math.max(1, Math.round(img.naturalHeight * shrink));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);
    return {
      width,
      height,
      frames: [{ image: canvas, delay_ms: 0 }],
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load: ${url}`));
    img.src = url;
  });
}

export function ImageComposer({
  panelId,
  config,
}: {
  panelId: string;
  config: ImageSceneConfig;
}) {
  const [busy, setBusy] = useState<"decode" | "transmit" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The decoded upload stays in memory for this session so the crop
  // can be re-adjusted after applying without re-picking the file
  // (the stored config only carries the panel-res bitmap).
  const [upload, setUpload] = useState<{
    id: number;
    name: string;
    source: CropSource;
    lastCrop?: CropTransform;
  } | null>(null);
  const [editing, setEditing] = useState(false);

  const handleFile = async (file: File) => {
    setBusy("decode");
    setErr(null);
    try {
      const source = await loadStill(file);
      setUpload({ id: Date.now(), name: file.name, source });
      setEditing(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleApply = async (t: CropTransform) => {
    if (!upload) return;
    setBusy("transmit");
    setErr(null);
    try {
      const next = cropStill(upload.source, t, upload.name);
      await panels.setMode.call(panelId, "image", next);
      setUpload({ ...upload, lastCrop: t });
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const hasImage = config.bitmap.length > 0;

  return (
    <ComposerShell title="image" status="static · 64×64 max" ariaLabel="Image configuration">
      <UploadRow
        accept="image/*"
        idleLabel="choose file"
        busyLabel={busy === "transmit" ? "transmitting…" : "loading…"}
        busy={busy != null}
        status={
          editing && upload
            ? `${upload.name} · ${upload.source.width}×${upload.source.height} · cropping`
            : hasImage
              ? `${config.source ?? "uploaded"} · ${config.width}×${config.height}`
              : "no image set"
        }
        onFile={(file) => void handleFile(file)}
      />

      {err ? <Alert>err: {err}</Alert> : null}

      {upload && editing ? (
        <>
          <div className="border-t border-dashed border-(--color-hairline)" />
          <CropEditor
            key={upload.id}
            source={upload.source}
            initial={upload.lastCrop}
            busy={busy != null}
            busyLabel="transmitting…"
            onApply={(t) => void handleApply(t)}
            onCancel={() => setEditing(false)}
          />
        </>
      ) : upload ? (
        <AdjustCropButton name={upload.name} onClick={() => setEditing(true)} />
      ) : null}
    </ComposerShell>
  );
}

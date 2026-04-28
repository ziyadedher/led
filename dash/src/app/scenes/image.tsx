"use client";

import { useRef, useState } from "react";

import {
  DEFAULT_IMAGE_CONFIG,
  type ImageSceneConfig,
} from "./types";

import { ComposerShell } from "@/app/components/ComposerShell";
import { panels } from "@/utils/actions";

const PANEL_W = 64;
const PANEL_H = 64;

export function parseImageConfig(raw: unknown): ImageSceneConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_IMAGE_CONFIG;
  const obj = raw as Record<string, unknown>;
  const width = typeof obj.width === "number" ? obj.width : 0;
  const height = typeof obj.height === "number" ? obj.height : 0;
  const bitmap = Array.isArray(obj.bitmap) ? (obj.bitmap as number[]) : [];
  const source = typeof obj.source === "string" ? obj.source : undefined;
  if (
    width <= 0 ||
    height <= 0 ||
    bitmap.length !== width * height * 3
  ) {
    return DEFAULT_IMAGE_CONFIG;
  }
  return { width, height, bitmap, source };
}

/**
 * Read an image from a URL or File, downsample (fit + center) to
 * panel dims, and return RGB888 row-major bytes.
 */
async function loadAndDownsample(
  src: string | File,
): Promise<ImageSceneConfig> {
  const url = typeof src === "string" ? src : URL.createObjectURL(src);
  try {
    const img = await loadImage(url);
    const ratio = Math.min(PANEL_W / img.width, PANEL_H / img.height);
    const drawW = Math.max(1, Math.round(img.width * ratio));
    const drawH = Math.max(1, Math.round(img.height * ratio));

    const canvas = document.createElement("canvas");
    canvas.width = drawW;
    canvas.height = drawH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, drawW, drawH);
    const data = ctx.getImageData(0, 0, drawW, drawH).data;
    const bitmap: number[] = new Array(drawW * drawH * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      bitmap[j] = data[i];
      bitmap[j + 1] = data[i + 1];
      bitmap[j + 2] = data[i + 2];
    }
    return {
      width: drawW,
      height: drawH,
      bitmap,
      source: typeof src === "string" ? src : src.name,
    };
  } finally {
    if (typeof src !== "string") URL.revokeObjectURL(url);
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const apply = async (next: ImageSceneConfig) => {
    setBusy(true);
    setErr(null);
    try {
      await panels.setMode.call(panelId, "image", next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File) => {
    setBusy(true);
    setErr(null);
    try {
      const next = await loadAndDownsample(file);
      await apply(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const handleUrl = async () => {
    if (!urlDraft.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const next = await loadAndDownsample(urlDraft.trim());
      await apply(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const hasImage = config.bitmap.length > 0;

  return (
    <ComposerShell title="image" status="static · 64×64 max" ariaLabel="Image configuration">
      <div className="space-y-4 px-4 py-4">
        <div className="space-y-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
            :: upload
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              className="border border-(--color-accent)/60 bg-(--color-accent)/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.3em] text-(--color-accent) transition hover:bg-(--color-accent)/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "loading…" : "choose file"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
                e.target.value = "";
              }}
            />
            {hasImage ? (
              <span className="truncate font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-text-faint)">
                {config.source ?? "uploaded"} · {config.width}×{config.height}
              </span>
            ) : (
              <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-(--color-text-faint)">
                no image set
              </span>
            )}
          </div>
        </div>

        <div className="border-t border-dashed border-(--color-hairline)" />

        <div className="space-y-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-dim)">
            :: url
          </span>
          <div className="flex items-center gap-2 border-b border-(--color-border-strong) pb-1.5 focus-within:border-(--color-accent)">
            <span aria-hidden className="font-mono text-(--color-accent)">
              ▸
            </span>
            <input
              type="text"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleUrl();
              }}
              placeholder="https://..."
              spellCheck={false}
              className="w-full border-0 bg-transparent p-0 font-mono text-sm text-(--color-text) placeholder:text-(--color-text-faint) focus:outline-none focus:ring-0"
            />
            <button
              type="button"
              onClick={() => void handleUrl()}
              disabled={busy || !urlDraft.trim()}
              className="font-mono text-[10px] uppercase tracking-[0.3em] text-(--color-text-muted) transition hover:text-(--color-accent) disabled:opacity-40"
            >
              fetch ↵
            </button>
          </div>
        </div>

        {err ? (
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-(--color-danger)">
            err: {err}
          </p>
        ) : null}
      </div>
    </ComposerShell>
  );
}

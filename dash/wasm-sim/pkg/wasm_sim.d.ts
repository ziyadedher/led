/* tslint:disable */
/* eslint-disable */

export class Renderer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Create a renderer for a `width × height` matrix. Sized to match
     * the panel (default 64×64).
     */
    constructor(width: number, height: number);
    /**
     * Replace the renderable state (entries + panel scroll/pause/flash).
     * Pass a JSON string; we parse here so the JS shape is whatever
     * `serde` accepts on `Scene`.
     */
    setSceneJson(json: string): void;
    /**
     * Render the current frame into the pixel buffer and return the
     * RGBA bytes. `now_ms` is the caller's monotonic clock — pass the
     * requestAnimationFrame timestamp (or `performance.now()`); steps
     * advance from elapsed time unless the panel is paused/off, so
     * animations resume exactly where they froze. JS wraps the result
     * as a Uint8ClampedArray and feeds it to ImageData; wasm-bindgen
     * copies the bytes once on return — 16KiB at rAF is negligible.
     */
    tick(now_ms: number): Uint8Array;
}

export function init(): void;

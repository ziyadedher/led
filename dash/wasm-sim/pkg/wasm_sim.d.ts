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
     * Render the current frame at the current step into the pixel
     * buffer, advance step (unless paused), and return the RGBA bytes.
     * JS wraps the result as a Uint8ClampedArray and feeds it to
     * ImageData. wasm-bindgen copies the bytes once on return — for
     * 64×64×4 = 16KiB at rAF that's negligible.
     */
    tick(): Uint8Array;
}

export function init(): void;

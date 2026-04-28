/* tslint:disable */
/* eslint-disable */

export class Renderer {
    free(): void;
    [Symbol.dispose](): void;
    height(): number;
    /**
     * Create a renderer for a `width × height` matrix. Sized to match
     * the panel (default 64×64).
     */
    constructor(width: number, height: number);
    /**
     * Reset the step counter so animations restart deterministically.
     */
    reset(): void;
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
    width(): number;
}

export function init(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_renderer_free: (a: number, b: number) => void;
    readonly renderer_height: (a: number) => number;
    readonly renderer_new: (a: number, b: number) => number;
    readonly renderer_reset: (a: number) => void;
    readonly renderer_setSceneJson: (a: number, b: number, c: number) => [number, number];
    readonly renderer_tick: (a: number) => [number, number, number, number];
    readonly renderer_width: (a: number) => number;
    readonly init: () => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

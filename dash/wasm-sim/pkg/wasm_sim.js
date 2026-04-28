/* @ts-self-types="./wasm_sim.d.ts" */
import * as wasm from "./wasm_sim_bg.wasm";
import { __wbg_set_wasm } from "./wasm_sim_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    Renderer, init
} from "./wasm_sim_bg.js";

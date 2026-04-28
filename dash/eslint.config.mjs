// ESLint v9 flat config for Next.js 16. Pulls in next-config's flat-config
// `core-web-vitals` preset (which already includes Next + React + a11y +
// TypeScript + import rules) and layers our import-order rule on top.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

export default [
  ...nextCoreWebVitals,
  {
    rules: {
      "import/order": "error",
      "import/no-named-as-default": "off",
    },
  },
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "next-env.d.ts",
      "wasm-sim/pkg/**",
      "wasm-sim/target/**",
    ],
  },
];

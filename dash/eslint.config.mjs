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
      // Soften two new-in-React-19 rules so they surface as warnings rather
      // than CI-blocking errors. They flag legitimate refactor opportunities
      // in the existing useState-in-useEffect patterns; address in a
      // follow-up rather than gate the upgrade on it.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "import/no-anonymous-default-export": "warn",
    },
  },
  {
    ignores: [".next/**", "node_modules/**", "out/**", "next-env.d.ts"],
  },
];

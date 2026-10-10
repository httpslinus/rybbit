import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// Feature verification without changing the repository's existing lint policy.
export default [
  ...nextCoreWebVitals,
  ...nextTypescript,
  { rules: { "@typescript-eslint/no-explicit-any": "off" } },
];

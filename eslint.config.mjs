import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([".next/**", "out/**", "build/**", "dist/**", ".npm-cache/**", "work/**", "outputs/**", "next-env.d.ts", "test-results/**", "playwright-report/**"]),
]);

import { readFile } from "node:fs/promises";

const baseline = JSON.parse(await readFile(new URL("baseline-load-evidence.json", import.meta.url), "utf8"));
const observed = new Set(baseline.runtimeErrors.map(error => error.message));

export function isKnownRuntimeError(error, siteId) {
  const stripeError =
    "Uncaught (in promise) IntegrationError: Please call Stripe() with your publishable key. You used an empty string.";
  if (error.message === stripeError) return true;
  return observed.has(error.message) && new URL(error.url).pathname === `/${siteId}/heatmaps`;
}

import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const installDeepEvalTelemetryCompatibility = () => {
  // ponytail: deepeval 0.9.x resolves a legacy dist/telemetry.js before its
  // newer telemetry/ directory; patch only the absent hooks needed by the
  // Vitest matcher and BaseMetric so upgrading deepeval can remove this shim.
  const entry = require.resolve("deepeval");
  const legacyTelemetry = require(path.join(path.dirname(entry), "telemetry.js"));
  if (typeof legacyTelemetry.inComponentScope !== "function") legacyTelemetry.inComponentScope = () => false;
  if (typeof legacyTelemetry.recordMetric !== "function") legacyTelemetry.recordMetric = () => {};
  if (typeof legacyTelemetry.recordTestCase !== "function") legacyTelemetry.recordTestCase = () => {};
  return legacyTelemetry;
};

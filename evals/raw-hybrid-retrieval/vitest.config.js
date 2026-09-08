import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  root: repoRoot,
  test: {
    include: ["evals/raw-hybrid-retrieval/raw-hybrid-retrieval.eval.js"],
    // The evaluator already enforces a finite timeout for each query. The test
    // covers the whole dataset, so Vitest's default five-second test timeout
    // would interrupt a valid run before the first query finishes.
    testTimeout: 0
  }
});

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@myknow/config";
import { prepareRawHybridEmbeddingSnapshot, preflightRawHybridEmbedding } from "../evals/raw-hybrid-retrieval/src/embedding-snapshot.js";

const defaultDataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../evals/raw-hybrid-retrieval/data");

const dataDirFromArgs = (args) => {
  const option = args.find((value) => value.startsWith("--data-dir="));
  return path.resolve(option ? option.slice("--data-dir=".length) : process.env.RAW_HYBRID_EVAL_DATA_DIR || defaultDataDir);
};
const hasFlag = (args, flag) => args.includes(flag);
const sampleSizeFromArgs = (args) => Number(args.find((value) => value.startsWith("--sample-size="))?.slice("--sample-size=".length) || 3);

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2);
    const dataDir = dataDirFromArgs(args);
    const config = loadConfig();
    const result = hasFlag(args, "--preflight")
      ? await preflightRawHybridEmbedding({ dataDir, config, env: process.env, sampleSize: sampleSizeFromArgs(args) })
      : await prepareRawHybridEmbeddingSnapshot({ dataDir, config, env: process.env });
    console.log(JSON.stringify(result.snapshot
      ? { path: result.path, manifest: result.snapshot.manifest, vectorCount: result.snapshot.vectors.length }
      : result, null, 2));
  } catch (caught) {
    console.error(`Raw hybrid embedding preparation failed [${caught.code || "EVAL_EMBEDDING_PREPARATION_FAILED"}]: ${caught.message}`);
    process.exitCode = 1;
  }
}

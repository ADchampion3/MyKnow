# 03 — Real embedding snapshot preparation

**What to build:** Provide an explicit preparation flow that embeds the evaluation corpus with the configured real HTTP-compatible embedding provider and produces a validated snapshot that the raw hybrid eval can consume safely.

**Blocked by:** 01 — Raw hybrid evaluation data contract and isolated fixture.

**Status:** resolved

**Label:** ready-for-agent

- [x] Reuse the project’s existing embedding environment configuration and require an explicit embedding model for real-provider runs.
- [x] Validate the configured provider, endpoint, model, and expected 4096 dimensions before making the snapshot available.
- [x] Generate vectors for every corpus raw child chunk and record provider, model, dimensions, input hashes, and generation metadata in the manifest.
- [x] Write the snapshot atomically so an endpoint failure, invalid response, or dimension mismatch cannot leave a consumable partial artifact.
- [x] Reject stale corpus hashes, provider/model mismatches, and incompatible dimensions when the snapshot is consumed.
- [x] Never silently fall back to the mock provider.
- [x] Keep ordinary evaluation runs read-only with respect to the snapshot; refreshing it must require an explicit preparation command.

## Comments

Implemented by `scripts/prepare-raw-hybrid-eval-embeddings.js`; failed
preparation leaves an existing snapshot unchanged.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCIFACT_ARCHIVE_BYTES,
  SCIFACT_ARCHIVE_MD5,
  SCIFACT_ARCHIVE_SHA256,
  convertSciFactSources
} from "../scripts/import-scifact.js";

const roots = [];
const makeSource = ({ qrels = "query-id\tcorpus-id\tscore\nq1\td1\t1\n" } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myknow-scifact-test-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "corpus.jsonl"), `${JSON.stringify({ _id: "d1", title: " Title\u212A ", text: " Evidence\u00a0text " })}\n`);
  fs.writeFileSync(path.join(root, "queries.jsonl"), `${JSON.stringify({ _id: "q1", text: "find evidence" })}\n`);
  fs.mkdirSync(path.join(root, "qrels"));
  fs.writeFileSync(path.join(root, "qrels", "test.tsv"), qrels);
  return root;
};

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("SciFact source conversion", () => {
  it("maps one document to one raw child and preserves test provenance", () => {
    const result = convertSciFactSources({ sourceRoot: makeSource(), archive: { sha256: SCIFACT_ARCHIVE_SHA256, md5: SCIFACT_ARCHIVE_MD5, bytes: SCIFACT_ARCHIVE_BYTES }, verifyOfficialCounts: false });
    expect(result.corpus.chunks).toHaveLength(1);
    expect(result.corpus.chunks[0]).toMatchObject({ chunkId: "scifact:chunk:d1", resourceId: "scifact:resource:d1", title: "TitleK", contextHeader: "TitleK", content: "Evidence text", parentChunkId: null, parentContent: null });
    expect(result.queries.queries[0]).toMatchObject({ id: "scifact:query:q1", tags: ["beir", "scifact", "test", "en"] });
    expect(result.qrels.judgments[0].relevant).toEqual([{ chunkId: "scifact:chunk:d1", grade: 1 }]);
    expect(result.manifest.counts.actual).toMatchObject({ corpus: 1, queries: 1, qrels: 1, qrelQueries: 1 });
    expect(result.manifest.normalization.affected.corpusText).toBe(1);
  });

  it("rejects malformed and unresolvable test qrels", () => {
    expect(() => convertSciFactSources({ sourceRoot: makeSource({ qrels: "query-id\tcorpus-id\tscore\nq1\tmissing\t1\n" }), archive: { sha256: SCIFACT_ARCHIVE_SHA256, md5: SCIFACT_ARCHIVE_MD5, bytes: SCIFACT_ARCHIVE_BYTES }, verifyOfficialCounts: false })).toThrow(/unknown corpus/u);
  });
});

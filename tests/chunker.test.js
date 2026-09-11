import { describe, expect, it } from "vitest";
import { chunkDocument, embeddingInputText } from "@myknow/db";

describe("chunkDocument", () => {
  it("does not emit a child chunk with an empty embedding input", () => {
    const document = chunkDocument("a\n", { strategy: "heuristic", parentChunkSize: 4096, childChunkSize: 1, childOverlap: 0 });
    const inputs = document.children.map((chunk) => embeddingInputText({ ownerType: "raw_chunk", content: chunk.content, contextHeader: chunk.contextHeader }));

    expect(document.children).toHaveLength(1);
    expect(document.children[0]).toMatchObject({ start: 0, end: 1, content: "a" });
    expect(inputs.every((input) => input.trim())).toBe(true);
  });
});

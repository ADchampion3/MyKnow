import { chunkDocument } from "@myknow/db";

const source = [
  "# Research notes",
  "",
  ...Array.from({ length: 8 }, (_, index) => `## Section ${index + 1}\n\nThis deterministic evidence paragraph ${index + 1} contains searchable context and emoji 😀. ${"context ".repeat(70)}`),
  "",
  "```js\nconst protectedHeading = '# not a heading';\n```",
  "",
  "| field | value |\n| --- | --- |\n| mode | parent-child |"
].join("\n");
const document = chunkDocument(source, { strategy: "heading", parentChunkSize: 800, childChunkSize: 120, childOverlap: 24 });
for (const [sample, chunk] of document.output.slice(0, 20).entries()) {
  console.log(JSON.stringify({ sample, strategy: document.strategy, chunkType: chunk.chunkType, sequence: chunk.sequence, parentIndex: chunk.parentIndex, childIndex: chunk.childIndex ?? null, start: chunk.start, end: chunk.end, forcedSplit: Boolean(chunk.forcedSplit), contentPrefix: chunk.content.slice(0, 32) }));
}

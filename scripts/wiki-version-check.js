import assert from "node:assert/strict";
import { diffMarkdown, parseMarkdownBlocks } from "@myknow/db";

const before = "# Topic\n\nOld answer\n";
const after = "# Topic\n\nNew answer\n\nAdded line\n";
const firstBlocks = parseMarkdownBlocks(before);
assert.deepEqual(parseMarkdownBlocks(before), firstBlocks);
assert.notEqual(parseMarkdownBlocks(after)[0].blockKey, undefined);
const diff = diffMarkdown(before, after);
assert.ok(diff.added.includes("New answer"));
assert.ok(diff.added.includes("Added line"));
assert.ok(diff.removed.includes("Old answer"));
console.log(JSON.stringify({ status: "passed", stableBlockKey: firstBlocks[0].blockKey, added: diff.added, removed: diff.removed }));

import assert from "node:assert/strict";
import { normalizeCitationLocator } from "@myknow/db";

assert.deepEqual(normalizeCitationLocator({ startOffset: 0, endOffset: 10 }), { startOffset: 0, endOffset: 10 });
assert.deepEqual(normalizeCitationLocator({ startOffset: 0, endOffset: 10 }, { sourceLength: 10 }), { startOffset: 0, endOffset: 10 });
assert.deepEqual(normalizeCitationLocator({ page: 2, pages: [2, 3], selector: "paragraph-1" }), { page: 2, pages: [2, 3], selector: "paragraph-1" });
assert.deepEqual(normalizeCitationLocator({ page: 2 }, { pageCount: 2 }), { page: 2 });
assert.throws(() => normalizeCitationLocator({ startOffset: 10, endOffset: 10 }), /increasing range/);
assert.throws(() => normalizeCitationLocator({ startOffset: 0, endOffset: 11 }, { sourceLength: 10 }), /source length/);
assert.throws(() => normalizeCitationLocator({ page: 3 }, { pageCount: 2 }), /page count/);
assert.throws(() => normalizeCitationLocator({ pages: [0] }), /positive integers/);
assert.throws(() => normalizeCitationLocator({}), /source position/);
console.log(JSON.stringify({ status: "passed", locatorForms: ["offset-range", "page-range-selector"], invalidCases: 5 }));

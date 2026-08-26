# Wiki citation evidence

Commands: `node scripts/wiki-citation-check.js`, `node scripts/wiki-contract.js`

The page contract binds a citation to the imported resource's immutable `resourceVersionId` and `{ startOffset: 0, endOffset: 10 }`. The response includes the citation under the page version, and subsequent page versions copy the citation unless the caller replaces the citation array.

`GET /api/wiki/citations/:id/preview` re-validates the immutable source bytes, resolves text offsets against that source, and returns the locator range plus a bounded read-only snippet. The Web citation card exposes this preview and a direct link to the corresponding resource-version download.

Text locator resolution uses the same BOM/CRLF normalization as the Worker canonical text. Indexed PDF locators use verified canonical-artifact length and page-count metadata when available; unresolved targets are reported as `broken` during impact scanning.

The API validates:

- the resource version belongs to the same knowledge base;
- locator offsets are finite, non-negative, ordered integers within the available source/canonical text length;
- page locators are bounded by the indexed source page count when that metadata exists;
- an optional block key belongs to the page version's derived blocks;
- source content cannot be replaced or deleted through the resource API.

The source read-only assertions pass with `RESOURCE_READ_ONLY`; the citation remains tied to the original version rather than the moving resource current pointer.

Focused helper result: `wiki-citation-check.js` passed offset-range, page-range/selector, source-boundary, page-count, and five invalid-locator assertions.

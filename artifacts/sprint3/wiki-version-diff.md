# Wiki version/diff evidence

Commands: `node scripts/wiki-version-check.js`, `node scripts/wiki-contract.js`

The contract creates a page with the initial content:

```markdown
# Contract concept

## Definition

Old answer
```

It then creates a second immutable version with `New answer` and `Added line`. The deterministic diff assertion reports:

```text
added:   New answer
added:   Added line
removed: Old answer
```

The stale write uses the first version as `baseVersionId` after the second version is current and is rejected with `409 WIKI_VERSION_CONFLICT`. Restoring the first version creates a third version with `restoreOfVersionId` set to the first version; the version list remains length 3.

Focused helper result: `wiki-version-check.js` passed stable block-key parsing and the added/removed line assertions.

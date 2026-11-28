## Summary
<!-- What changed and why? Reference any related issue (`Closes #...`). -->

## Platform Tested
- [ ] macOS (`darwin`)
- [ ] Windows 10/11 (`win32`)
- [ ] Remote PWA / Gateway / Android

## Verification Checklist
- [ ] `npm run build:remote && npm test` passed locally with 0 failures and 0 skipped
- [ ] Added a scoped entry (`[cross]`, `[mac]`, `[win]`, or `[remote]`) under `## [Unreleased]` in `CHANGELOG.md`
- [ ] Ran `npm run probe:host` (required only if touching host selectors, React fiber lookups, or RPC/SQLite/Protobuf contracts)
- [ ] Kept new modules `< 2,000` lines, added zero CSS `:has(...)` rules, and left generated build bundles untracked

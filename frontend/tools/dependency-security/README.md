# Development matcher mitigation mirror

These four files are exact copies of the selected backend artifact, metadata,
license and built-in integrity verifier. They keep this frontend Docker context
self-contained; no build reaches outside its context.

See [the canonical review and compatibility limits](../../../backend/tools/dependency-security/README.md).
Verify both mirrors from the repository root with
`node backend/tools/dependency-security/sync-mirrors.mjs`; use `--write` only after
an intentional canonical regeneration. Keep the original version/advisory visible.

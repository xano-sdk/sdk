# Deploy runbook

## Environments

- **ephemeral** — auto-expiring, created per deploy. Safe to replace wholesale.
- **sandbox** — shared, long-lived. Replacing it disrupts everyone using it.

## Before you ship

1. The test suite passes.
2. The migration is reversible, or the change is additive.
3. Someone other than the author has read the diff.

## Rolling back

See `refs/rollback.md` for the ordered steps, and `refs/environments.md` for
which environment tolerates a full replace.

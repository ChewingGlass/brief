# Risk tiers: example

This file shows the format for a service monorepo. Copy it to `<repo>/.claude/brief-risk.md`
or `~/.claude/brief/risk/<repo-name>.md`, and replace the paths with your own.

The first matching row wins. Paths are relative to the repo root.

## Critical

Value transfer, the hot path, and persisted data layout.

- `src/ledger/`
- `src/payments/{charge,refund,settle}*`
- `src/auth/`
- `migrations/`

## High

Other server code and the libraries it shares.

- `src/`, `crates/`, `packages/core/`

## Medium

Code that can lose data or give wrong results without an error.

- `packages/sdk/src/`
- `workers/`

## Low

- `scripts/`, `.github/`, `deploy/`
- `docs/`, `*.md`
- Tests: `tests/`, `**/tests/`, `*.test.ts`
- Generated: `**/generated/`, `*.lock`

## Raise one tier when the change

- adds or changes a money movement or an external API call
- adds, removes or moves a field in a persisted struct or table
- changes an authorization or permission check
- changes the error type or a public enum
- deletes or weakens an assertion in a test (applies to tests only)

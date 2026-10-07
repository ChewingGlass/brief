# Risk tiers: example

This file is an example from a Solana exchange monorepo. Copy it to `<repo>/.claude/brief-risk.md`
or `~/.claude/brief/risk/<repo-name>.md`, and replace the paths with your own.

The first matching row wins. Paths are relative to the repo root.

## Critical

Value transfer, the matching hot path, and account layout.

- `programs/velocity/src/lib.rs` (the native opcode dispatch)
- `programs/velocity/src/controller/{orders,matching,liquidation,pnl,position,spot_balance,spot_position,token,funding,isolated_position,insurance,equity_floor}*`
- `programs/velocity/src/math/`
- `programs/velocity/src/state/{user,perp_market,spot_market,state,oracle,oracle_map,margin_calculation,fill_mode,quoter_cross,router_quote}*`
- `programs/velocity/src/vlp/`
- `programs/velocity/src/instructions/{router,clob,liq_relay,trigger_relay}/`
- `anchor-v2/programs/clob/`
- `crates/clob-state*/`, `crates/clob-wire*/`

## High

Other program code and the crates the programs share.

- `programs/`, `anchor-v2/programs/`, `crates/`

## Medium

Offchain code that can lose money or mispredict without an error.

- `packages/sdk/src/math/`, `packages/sdk/src/{user,velocityClient}.ts`
- `rust/keep-rs/`, `rust/swift/`, `rust/velocity-rs/`, `rust/book-publisher/`
- `apps/keeper-bots-v2/`
- `packages/vaults-sdk/`, `packages/revenue-router-sdk/`
- `packages/sdk/src/`

## Low

- `packages/cli-admin/`, `apps/dlob-server/`, `apps/usermap-server/`
- `local-stack/`, `deploy-scripts/`, `test-scripts/`, `.github/`
- `docs/`, `*.md`, `.changeset/`
- Tests: `tests/`, `integration-tests/`, `fuzz/`, `**/tests/`, `*.test.ts`, `programs/protocol-revenue-router/svm-tests/`
- Generated: `packages/sdk/src/idl/`, `rust/velocity-rs/crates/src/velocity_idl.rs`, `*.lock`

## Raise one tier when the change

- adds or changes a token transfer or a CPI
- adds, removes or moves a field in a zero-copy account struct
- changes a signer, `has_one`, `seeds`, `address =` or authority check
- changes an oracle validity gate or which price an operation uses
- changes the `Error` enum or an ABI-visible enum
- deletes or weakens an assertion in a test (applies to tests only)

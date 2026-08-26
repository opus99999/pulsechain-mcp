# Signals Platform initial authority synchronization

## Approved summary

The exact PRVX rc.2 resolution package validated, including the issued methodology `pulsechain-prvx-canonical-market-history@1.0.0-rc.2`, its deterministic read-only decision hash, and the preserved historical activity gaps.

The exact later production-canary package also validated as `RC2_PRODUCTION_CANARY_ABORTED — NO_PRODUCTION_WRITE`. Sites version 47 was saved but its deployment failed before launch because migration statement 136 targeting `canonical_technical_input_sets_v2` was too large. Production retained Sites version 46, no canonical-v2 tables or rows, and an unpromoted legacy PRVX reader.

Exact R06–R09 successor ZIP candidates were located, but their bytes could not be materialized for independent SHA-256 and internal-inventory validation. They are quarantined and do not supersede the aborted-canary authority. The synchronization made no Signals source, Sites, D1, reader, scanner, Piteas, portfolio, wallet, order, or execution change.

## Complete final response

**SIGNALS_PLATFORM_INITIAL_SYNC_PARTIAL — RC2_AND_ABORTED_CANARY_IMPORTED — LATER_REPAIR_STATE_UNVERIFIED**

- rc.2 resolution validation: PASS.
- Issued methodology: `pulsechain-prvx-canonical-market-history@1.0.0-rc.2`.
- Frozen decision: Long Score 28, Exit Score 100, `NO_SETUP`; decision hash `sha256:5f24f85958654121409755b4e5942318b3b965a33c0cd55ec9fe324d4d19236c` on both runs.
- Aborted-canary validation: PASS; classification `RC2_PRODUCTION_CANARY_ABORTED — NO_PRODUCTION_WRITE`.
- Exact failure: `drizzle/0025_chubby_may_parker.sql`, zero-based statement 136, `canonical_technical_input_sets_v2`, 270,637 bytes, `SQLITE_TOOBIG`.
- Current production: defensible Signals v46 / `e3b70c12d8deed14b36cc1d82459bdb3ed8b6007`; 36 D1 tables; all six canonical-v2 tables absent; v2 row counts zero; PRVX reader legacy and unpromoted.
- Runtime snapshot: scanner catching up; observer and Piteas stale/blocked. Portfolio remains disabled and locked; equity unset; positions, fills, ledger entries, and transitions zero; wallet, orders, and execution disabled.
- Later repair state: unverified because exact ZIP bytes/internal manifests were unavailable; no production repair, deployment, D1 write, or reader promotion is inferred.
- Next permitted action: PRVX rc.2 statement-size-safe migration repair and additive shadow-write retry, starting with exact R06–R09 recovery/validation or quarantine.

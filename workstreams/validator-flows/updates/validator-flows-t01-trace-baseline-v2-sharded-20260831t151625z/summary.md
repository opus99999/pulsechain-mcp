# T01 Trace Baseline V2 deterministic sharded retrieval

## Approved summary

The monolithic trace request shape did not produce a response. Under the separately authorized deterministic-sharding contract, G4MM4 qualified at the first ladder width tested: 5,000 blocks. Six probe transmissions passed across two rounds, after which two independent ten-shard retrieval passes each returned 251 raw and normalized rows with no duplicates, malformed rows, out-of-range rows, or retries. Both passes produced normalized-row-set SHA-256 `edc429c841f176403f95cf66d78def0d558ff643ed41d75fcd66fcd70abea11a` and canonical partition SHA-256 `d5b4bdf36a97c3872a910611733e91dce6cd8c8584033537af5feab691132eec`.

G4MM4 and rpc.pulsechain.com agreed on chain ID 369, the frozen cutoff, boundary anchors, and 156 distinct trace-row block headers. The 36 preserved partition bytes remained unchanged. Two independent local builds produced a prospective 37-physical-partition V2 baseline with 7,834 normalized rows, manifest SHA-256 `603ce7ad0a60832f72d6081473ca6e1e00339c350c4c01b18fb041df6ff349d4`, and aggregate normalized SHA-256 `ee7a34f596b01220fda4a2f9e19d36853e58600290bffc266808d99f21d94aaa`.

This checkpoint does not claim equivalence to the lost original ordinal-15 artifact or historical manifest. No other partition was queried, the accepted checkpoint was not mutated, the solver was not run, and no economic conclusion changed. The existing economic safe stop remains controlling.

## Complete final response

T01_TRACE_BASELINE_V2_ESTABLISHED —
G4MM4_SHARDED_TRACE_SOURCE_QUALIFIED —
INCOMING_ORDINAL15_REPRODUCED_IN_TWO_COMPLETE_PASSES —
37_PHYSICAL_PARTITIONS_PROVEN —
ORIGINAL_HISTORICAL_EQUIVALENCE_NOT_CLAIMED —
SAFE_STOP_PRESERVED

- accepted checkpoint ID: validator-flows-t01-source-recovery-safe-stop-20260826t115000z
- source-lineage addendum: t01-source-lineage-correction-v2-20260831t111446z; SHA-256 a41b5d4e1361db7892546191c7c1cb3801648256462ace996538864268237e75
- normalization contract: t01-trace-normalization-v2@1.0.0; SHA-256 3e857b9cb223053c1e7c991f31f17ffcac2c8c62573c05b19f5658b4c5a1c7f3
- sharded-transport addendum: t01-trace-sharded-transport-v2@1.0.0; SHA-256 010628af76eef17e7176c4d9429f4f46936de5ae19ad101acfe3be81613cf35b
- trace source: https://rpc-pulsechain.g4mm4.io
- header-only corroborator: https://rpc.pulsechain.com
- anchor agreement: PASS
- candidate widths tested: 5,000
- selected shard width: 5,000 blocks
- selected shard count: 10
- qualification trace transmissions: 6
- Retrieval Pass 01 trace transmissions: 10
- Retrieval Pass 02 trace transmissions: 10
- retry count: 0
- total G4MM4 trace transmissions: 26 new; 29 cumulative including 3 preserved prior transmissions
- Pass 01 completed shards: 10
- Pass 02 completed shards: 10
- Pass 01 raw rows: 251
- Pass 02 raw rows: 251
- Pass 01 normalized rows: 251
- Pass 02 normalized rows: 251
- expected ordinal row count: 251
- Pass 01 normalized-row-set SHA-256: edc429c841f176403f95cf66d78def0d558ff643ed41d75fcd66fcd70abea11a
- Pass 02 normalized-row-set SHA-256: edc429c841f176403f95cf66d78def0d558ff643ed41d75fcd66fcd70abea11a
- Pass 01 partition SHA-256: d5b4bdf36a97c3872a910611733e91dce6cd8c8584033537af5feab691132eec
- Pass 02 partition SHA-256: d5b4bdf36a97c3872a910611733e91dce6cd8c8584033537af5feab691132eec
- canonical-header agreement: PASS across 156 distinct trace blocks and both authorized endpoints
- preserved 36-partition byte result: 36/36 PASS
- V2 physical partition count: 37
- V2 total normalized row count: 7,834
- expected aggregate row count: 7,834
- V2 manifest SHA-256: 603ce7ad0a60832f72d6081473ca6e1e00339c350c4c01b18fb041df6ff349d4
- V2 aggregate normalized SHA-256: ee7a34f596b01220fda4a2f9e19d36853e58600290bffc266808d99f21d94aaa
- deterministic second-run result: PASS
- historical equivalence claimed: false
- other partitions queried: 0
- accepted checkpoint mutation: no
- solver run: false
- economic conclusion changed: false
- secret disclosure: NONE
- protected-state delta: 0

The prospective V2 baseline is limited to source recovery and deterministic transport. The original ordinal-15 bytes and historical 37-partition manifest remain unrecoverable, the remaining 155 logical trace partitions remain unqueried, and the economic safe stop remains controlling.

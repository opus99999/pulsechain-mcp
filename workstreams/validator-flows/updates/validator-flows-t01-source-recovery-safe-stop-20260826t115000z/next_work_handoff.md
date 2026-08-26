1. Read the current validator-flows bootstrap and require the newest accepted state.
2. Revalidate the source-recovery and safe-stop artifact identities.
3. Confirm a `trace_filter` archive endpoint is healthy.
4. Retrieve incoming ordinal 15 only for blocks 23,302,023–23,352,022 and require exactly 251 traces.
5. Preserve raw responses and compute new byte and canonical-content hashes without claiming recovery of the lost original bytes.
6. Run every frozen 37-partition equivalence control.
7. Only after a full equivalence pass, resume incoming 16–95 and outgoing 21–95 with per-partition checkpoints.
8. Keep blanks unresolved, preserve a826, and do not begin rank two.

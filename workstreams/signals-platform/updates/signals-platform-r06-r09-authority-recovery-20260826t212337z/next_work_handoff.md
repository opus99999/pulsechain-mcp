# Next engineering handoff

Run one separately authorized, bounded R06–R09 byte and source-provenance recovery pass.

1. Read the current signals-platform bootstrap and bind to its current main head and latest Signals update.
2. Retrieve only the four exact Library file IDs recorded in R06_VALIDATION.json through R09_VALIDATION.json.
3. Verify each ZIP's filename, byte size, SHA-256, ZIP integrity, member count, internal inventory, governed member hashes, and embedded predecessor binding.
4. Validate source commit, tree, repaired migration bytes, schema and row counts, tests, production-write state, and deployment state from execution evidence.
5. Re-establish or formally quarantine R06 commit `2db257fd954062aabbd337fdb5c546c4f493506c` and tree `45085e8459e928e5f24938abc020f25815170daa`. Do not create a product-source commit without separate authorization.
6. Keep the PRVX reader unpromoted until production rows, hashes, source isolation, and rollback controls pass.

Preserve every rc.2 value, hash, null, gap index, unavailable event, and the unavailable full-window aggregate. Do not wake runtime services or activate portfolio or execution surfaces.

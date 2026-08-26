# Next work

Run a bounded PRVX rc.2 statement-size-safe migration repair and additive shadow-write retry.

First recover and validate or formally quarantine R06–R09 by exact filename, catalog byte size, SHA-256, internal inventory, source commit/tree, migration hash, deployment/D1 receipts, decision-hash read-back, and safety read-back. If an exact statement-safe repair validates, continue from that exact commit/tree instead of recreating it.

Preserve every frozen row value, ID, hash, null, gap index, unavailable event, methodology identifier, and reader behavior. Keep reader promotion disabled until production rows and hashes are proven. Do not reopen rc.2 methodology, wake runtime services, or activate portfolio, wallet, order, or execution surfaces.

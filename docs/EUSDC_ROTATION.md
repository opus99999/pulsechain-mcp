# eUSDC Five-Asset Rotation Engine

The v1 rotation engine scans exactly five eUSDC-facing candidates every cycle:

| Candidate | Execution token | Notes |
| --- | --- | --- |
| PLS | WPLS `0xA1077a294dDE1B09bB078844df40758a5D0f9a27` | Displays as PLS, trades wrapped PLS only. Native PLS remains gas reserve and is never trading inventory. |
| PLSX | `0x95B303987A60C71504D99Aa1b13B4DA07b0790ab` | Requires exact address, decimals, liquidity, volume, and sell route checks. |
| INC | `0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d` | May be scanned but rejected for low activity, unstable evidence, or unreliable route data. |
| pHEX | `0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39` | PulseChain state-fork HEX; never treated as bridged eHEX. |
| PRVX | `0xF6f8Db0aBa00007681F8fAF16A0FDa1c9B030b11` | Requires exact address, transferability, contract-call compatibility, and current routes both ways. |

The normal read-only workflow is:

```text
eusdc_rotation_history_sync
eusdc_rotation_history_status
eusdc_rotation_scan
```

`eusdc_rotation_history_sync` backfills public market history into `data/eusdc-rotation-history/`. The store contains only normalized public chain data: chain id, candidate id, pool address, protocol, block/transaction/log identifiers, timestamp, token addresses, raw swap amounts, candidate/eUSDC price, eUSDC notional, source, and fetch timestamp. It must not contain wallet keys, wallet records, `.env.wallet` contents, credentials, signed transactions, approvals, proposals, or execution state.

`eusdc_rotation_scan` uses read-only evidence: the local public history store, PulseX V1/V2 subgraphs, pool reserve data, paginated pair swaps, token metadata, token balances, allowances, bytecode checks, and route-connectivity checks. It does not call Piteas during routine scans. Every completed scan returns all five candidates, including rejected rows with explicit reasons.

Each live metric carries a data-quality envelope: value, unit, source, source time, window start/end, sample count, page count, truncation state, coverage percentage, stale flag, confidence, and warnings. Units are explicit (`token_raw`, `token_human`, `eusdc`, `usd`, `percent`, `bps`, `count`, or `minutes`). The scanner must not label raw reserves or raw token quantities as USD/eUSDC liquidity.

The history sync diagnoses each source by endpoint, query type, page size, maximum page count, cursor mechanism, oldest/newest returned record, requested time window, record counts, boundary status, truncation reason, repeated/capped cursor evidence, and pagination reliability. It distinguishes source row limits, pagination bugs, sparse actual trading, stale pools, missing pool discovery, failed block-time conversion, unsupported event ABIs, and RPC log-range limitations. When subgraph pagination cannot prove completeness, the sync can fall back to chunked `eth_getLogs` for supported V2-style swap events.

The scanner builds five-minute candles over the requested lookback from persisted public history when available. Swaps are deduplicated by chain id, transaction hash, and log index, sorted chronologically, converted into candidate/eUSDC observations, and aggregated into OHLCV candles. Direct candidate/eUSDC swaps are preferred. Candidate/WPLS prices are multiplied by historical WPLS/eUSDC anchor observations only when the anchor is within a bounded timestamp window; stale anchors are rejected.

Coverage has three separate meanings:

```text
sourceCompletenessPercent   = whether retrieval covered the requested source window
activeTradeCandlePercent    = five-minute buckets with actual observed swaps
priceContinuityPercent      = buckets with a usable bounded carry-forward price
```

Sparse carry-forward may support chart continuity and elapsed-time calculations, but it is not counted as a trade, volume, new high, new low, dip, or rebound.

Pool liquidity is consolidated from human-unit reserves and independently derived token prices:

```text
liquidityEusdc = reserve0Human * token0PriceEusdc + reserve1Human * token1PriceEusdc
```

The scan reports primary pool, eligible pools, excluded pools, aggregate liquidity, largest-pool liquidity, concentration, consolidated price, and price dispersion. Tiny manipulated pools, stale pools, mismatched pairs, missing bytecode, and unpriced reserves are excluded from candidate control.

Route connectivity is graph evidence, not executable proof. Routine sync, status, and scan tools still make zero Piteas calls. Statuses are `DIRECT_POOL`, `MULTIHOP_VIA_WPLS`, `MULTIHOP_OTHER_VERIFIED`, `UNKNOWN_UNTIL_EXECUTABLE_QUOTE`, or `UNAVAILABLE`; a later entry/exit proposer must still require a fresh Piteas quote and simulation before any transaction can be proposed.

The entry signal is deliberately narrow. A candidate must have complete source history or qualified sparse-event history, show a verified decline from a rolling local reference, show an actual-trade rebound with volume confirmation, avoid a new lower low afterward, avoid severe continuing downtrend, pass liquidity and route checks, and show historical evidence that the dynamic gross target is plausible. If no candidate qualifies, the engine returns `HOLD_EUSDC`, `INSUFFICIENT_HISTORY`, `INSUFFICIENT_EVIDENCE`, `TARGET_ECONOMICALLY_INFEASIBLE`, or `DATA_SOURCE_FAILURE`; it must not weaken criteria to force a trade.

Analysis modes are:

```text
DENSE_CANDLES       source complete and active candle coverage is at least 80%
SPARSE_EVENT_TIME   source complete with enough fresh actual trades and bounded gaps
UNUSABLE_HISTORY    incomplete, stale, too sparse, truncated, or otherwise unsafe
```

The engine holds at most one open position per wallet. It never rotates directly from one candidate to another. Every cycle must return to eUSDC before another candidate can be selected.

Piteas is called only after a scan-selected entry candidate exists, or after an open position appears close enough to its eUSDC exit target. Entry and exit proposal tools make exactly one Piteas quote request per attempt, do not automatically retry, and do not fall back to another candidate after quote failure. Piteas may route atomically through WPLS, PLSX, HEX, DAI, or other internal assets; callers should request the desired final token and must not manually chain separate intermediate transactions.

For a cycle starting with `S` raw eUSDC:

```text
simpleBalanceTargetRaw = ceil(S * 10100 / 10000)
```

For `S = 5222672`, the simple target is `5274899`. The executable exit floor also adds entry approval gas, entry swap gas, exit approval gas, projected exit swap gas, route cost, price impact, and a safety buffer converted into raw eUSDC. A scan reports both requested net target bps and required gross move bps. With the current fixture, the dynamic target is `5327915` raw eUSDC and the required gross move is about `201.51` bps, so a simple 1% chart reversion is not enough. When gas conversion is unavailable, profitability is unproven and automatic execution is not authorized.

The first live scan on this branch family exposed the initial candle defects. The next live scan showed the remaining defect: public subgraph pagination still could not prove complete 24-hour history for the active pools, so all candidates correctly returned `INSUFFICIENT_HISTORY`. The persistent history layer addresses that by separating source completeness from sparse trading, persisting normalized public history, reporting unresolved truncation explicitly, and preventing incomplete candidates from entering the eligible ranking. PRVX identity accepts the verified `ProveX` name when address, symbol, decimals, bytecode, and transferability match.

Proposal creation never signs or broadcasts. Entry and exit execution still require the existing wallet execution path with `confirm=true`. Version 1 has no unattended signing, no scheduling, no leverage, no borrowing, no liquidity provision, no averaging down, and no direct candidate-to-candidate trades. Full-position exits can lose token exposure if the market continues rising after sale.

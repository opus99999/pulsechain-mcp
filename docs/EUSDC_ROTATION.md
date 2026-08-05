# eUSDC Five-Asset Rotation Engine

The v1 rotation engine scans exactly five eUSDC-facing candidates every cycle:

| Candidate | Execution token | Notes |
| --- | --- | --- |
| PLS | WPLS `0xA1077a294dDE1B09bB078844df40758a5D0f9a27` | Displays as PLS, trades wrapped PLS only. Native PLS remains gas reserve and is never trading inventory. |
| PLSX | `0x95B303987A60C71504D99Aa1b13B4DA07b0790ab` | Requires exact address, decimals, liquidity, volume, and sell route checks. |
| INC | `0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d` | May be scanned but rejected for low activity, unstable evidence, or unreliable route data. |
| pHEX | `0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39` | PulseChain state-fork HEX; never treated as bridged eHEX. |
| PRVX | `0xF6f8Db0aBa00007681F8fAF16A0FDa1c9B030b11` | Requires exact address, transferability, contract-call compatibility, and current routes both ways. |

`eusdc_rotation_scan` uses read-only evidence: PulseX V1/V2 subgraphs, pool reserve data, paginated pair swaps, token metadata, token balances, allowances, bytecode checks, and route-connectivity checks. It does not call Piteas during routine scans. Every completed scan returns all five candidates, including rejected rows with explicit reasons.

Each live metric carries a data-quality envelope: value, unit, source, source time, window start/end, sample count, page count, truncation state, coverage percentage, stale flag, confidence, and warnings. Units are explicit (`token_raw`, `token_human`, `eusdc`, `usd`, `percent`, `bps`, `count`, or `minutes`). The scanner must not label raw reserves or raw token quantities as USD/eUSDC liquidity.

The scanner builds five-minute candles over the requested lookback by paginating pair swaps until the time boundary is crossed or a truncation cap is reached. Swaps are deduplicated by transaction plus swap id, sorted chronologically, converted into candidate/eUSDC observations, and aggregated into OHLCV candles. Direct candidate/eUSDC swaps are preferred. Candidate/WPLS prices are multiplied by historical WPLS/eUSDC anchor observations only when the anchor is within a bounded timestamp window; stale anchors are rejected. Sparse carry-forward may support chart continuity, but it is not counted as fresh movement or rebound evidence.

Pool liquidity is consolidated from human-unit reserves and independently derived token prices:

```text
liquidityEusdc = reserve0Human * token0PriceEusdc + reserve1Human * token1PriceEusdc
```

The scan reports primary pool, eligible pools, excluded pools, aggregate liquidity, largest-pool liquidity, concentration, consolidated price, and price dispersion. Tiny manipulated pools, stale pools, mismatched pairs, missing bytecode, and unpriced reserves are excluded from candidate control.

Route connectivity is graph evidence, not executable proof. Routine scans still make zero Piteas calls. Statuses are `DIRECT_POOL`, `MULTIHOP_VIA_WPLS`, `MULTIHOP_OTHER_VERIFIED`, `UNKNOWN_UNTIL_EXECUTABLE_QUOTE`, or `UNAVAILABLE`; a later entry/exit proposer must still require a fresh Piteas quote and simulation before any transaction can be proposed.

The entry signal is deliberately narrow. A candidate must show at least a 1% decline from a rolling local reference, at least a 0.2% rebound from the resulting local low, no severe continuing downtrend, sufficient liquidity and volume, bounded modeled price impact, fresh evidence, transferability, enough candle coverage, and routes both from eUSDC and back to eUSDC. If no candidate qualifies, the engine returns `HOLD_EUSDC`, `INSUFFICIENT_HISTORY`, `INSUFFICIENT_EVIDENCE`, `TARGET_ECONOMICALLY_INFEASIBLE`, or `DATA_SOURCE_FAILURE`; it must not weaken criteria to force a trade.

The engine holds at most one open position per wallet. It never rotates directly from one candidate to another. Every cycle must return to eUSDC before another candidate can be selected.

Piteas is called only after a scan-selected entry candidate exists, or after an open position appears close enough to its eUSDC exit target. Entry and exit proposal tools make exactly one Piteas quote request per attempt, do not automatically retry, and do not fall back to another candidate after quote failure. Piteas may route atomically through WPLS, PLSX, HEX, DAI, or other internal assets; callers should request the desired final token and must not manually chain separate intermediate transactions.

For a cycle starting with `S` raw eUSDC:

```text
simpleBalanceTargetRaw = ceil(S * 10100 / 10000)
```

For `S = 5222672`, the simple target is `5274899`. The executable exit floor also adds entry approval gas, entry swap gas, exit approval gas, projected exit swap gas, and a safety buffer converted into raw eUSDC. When gas conversion is unavailable, profitability is unproven and automatic execution is not authorized.

The first live scan on this branch family exposed four defects that this hardening addresses: returns and volatility were null because no candle pipeline existed; trade counts stopped at 50 because the scan made one capped swap request; WPLS/PLSX connectivity was false because only direct eUSDC pools were accepted; and WPLS/PLSX liquidity could inherit absurd `reserveUSD` values rather than reserve-normalized eUSDC liquidity. PRVX identity now accepts the verified `ProveX` name when address, symbol, decimals, bytecode, and transferability match.

Proposal creation never signs or broadcasts. Entry and exit execution still require the existing wallet execution path with `confirm=true`. Version 1 has no unattended signing, no scheduling, no leverage, no borrowing, no liquidity provision, no averaging down, and no direct candidate-to-candidate trades. Full-position exits can lose token exposure if the market continues rising after sale.

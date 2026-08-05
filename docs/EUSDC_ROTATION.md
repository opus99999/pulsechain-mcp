# eUSDC Five-Asset Rotation Engine

The v1 rotation engine scans exactly five eUSDC-facing candidates every cycle:

| Candidate | Execution token | Notes |
| --- | --- | --- |
| PLS | WPLS `0xA1077a294dDE1B09bB078844df40758a5D0f9a27` | Displays as PLS, trades wrapped PLS only. Native PLS remains gas reserve and is never trading inventory. |
| PLSX | `0x95B303987A60C71504D99Aa1b13B4DA07b0790ab` | Requires exact address, decimals, liquidity, volume, and sell route checks. |
| INC | `0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d` | May be scanned but rejected for low activity, unstable evidence, or unreliable route data. |
| pHEX | `0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39` | PulseChain state-fork HEX; never treated as bridged eHEX. |
| PRVX | `0xF6f8Db0aBa00007681F8fAF16A0FDa1c9B030b11` | Requires exact address, transferability, contract-call compatibility, and current routes both ways. |

`eusdc_rotation_scan` uses read-only evidence: PulseX V1/V2 subgraphs, direct pool/reserve data, recent swaps, token metadata, token balances, allowances, and route-availability checks. It does not call Piteas during routine scans. Every completed scan returns all five candidates, including rejected rows with explicit reasons.

The entry signal is deliberately narrow. A candidate must show at least a 1% decline from a rolling local reference, at least a 0.2% rebound from the resulting local low, no severe continuing downtrend, sufficient liquidity and volume, bounded modeled price impact, fresh evidence, transferability, and routes both from eUSDC and back to eUSDC. If no candidate qualifies, the engine returns `HOLD_EUSDC` or `INSUFFICIENT_EVIDENCE`; it must not weaken criteria to force a trade.

The engine holds at most one open position per wallet. It never rotates directly from one candidate to another. Every cycle must return to eUSDC before another candidate can be selected.

Piteas is called only after a scan-selected entry candidate exists, or after an open position appears close enough to its eUSDC exit target. Entry and exit proposal tools make exactly one Piteas quote request per attempt, do not automatically retry, and do not fall back to another candidate after quote failure. Piteas may route atomically through WPLS, PLSX, HEX, DAI, or other internal assets; callers should request the desired final token and must not manually chain separate intermediate transactions.

For a cycle starting with `S` raw eUSDC:

```text
simpleBalanceTargetRaw = ceil(S * 10100 / 10000)
```

For `S = 5222672`, the simple target is `5274899`. The executable exit floor also adds entry approval gas, entry swap gas, exit approval gas, projected exit swap gas, and a safety buffer converted into raw eUSDC. When gas conversion is unavailable, profitability is unproven and automatic execution is not authorized.

Proposal creation never signs or broadcasts. Entry and exit execution still require the existing wallet execution path with `confirm=true`. Version 1 has no unattended signing, no scheduling, no leverage, no borrowing, no liquidity provision, no averaging down, and no direct candidate-to-candidate trades. Full-position exits can lose token exposure if the market continues rising after sale.

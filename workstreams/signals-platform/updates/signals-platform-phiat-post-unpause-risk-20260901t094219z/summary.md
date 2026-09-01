# PHIAT post-unpause technical risk and executable liquidity

## Approved summary

At PulseChain block 27,433,467 (`2026-09-01T09:28:55Z`), the PHIAT LendingPool was globally unpaused and all 12 reviewed reserves were active. WPLS, HEX, PLSX, and INC were unfrozen and borrow-enabled; WPLS, HEX, and PLSX had zero LTV, while INC had 40% LTV and a 45% liquidation threshold. USDC, WETH, WBTC, DAI, USDT, USDL, HEXDC, and PXDC remained frozen with borrowing disabled and zero LTV; their nonzero liquidation thresholds remain relevant to existing collateral positions. Eleven assets depended on a keeper-set fallback oracle path with no on-chain price-age or deviation enforcement; WPLS used the base-currency path. Administrative reconfigurations, cancellations, and global unpause executed. Post-unpause activity resumed but remained exit/deleveraging-heavy by transaction count. Read-only PulseX quotes showed exceptionally thin PHIAT-specific executable USDC-reference sell depth. Solvency, reserve reconciliation, incident cause, loss, remediation completeness, oracle quality, and reopening rationale remain unresolved. No source, production, portfolio, wallet, order, or execution state changed.

## Complete final response

**PHIAT_POST_UNPAUSE_TECHNICAL_RISK_RESOLVED_BOUNDED — GLOBAL_UNPAUSE_CONFIRMED — SELECTIVE_RESERVE_RESTRICTIONS — EXIT_HEAVY_ACTIVITY — THIN_EXECUTABLE_LIQUIDITY — NO_EXECUTION_CHANGE**

- Global state: unpaused at block 27,433,467, `2026-09-01T09:28:55Z`, reproduced on three RPCs.
- Reserve state: 12 active; four unfrozen/borrow-enabled and eight frozen/borrow-disabled. WPLS, HEX, and PLSX have zero LTV; INC has 40% LTV. Every reviewed reserve except INC has zero LTV, while liquidation thresholds range from 45% to 80% and still govern existing collateral treatment.
- Oracle: no configured primary reserve sources; WPLS uses the base-currency short circuit and 11 assets route to the fallback. Nonzero outputs prove availability, not freshness, independence, or correctness.
- Administration: three collateral reconfigurations, nine cancellations of alternative configurations, and the global unpause executed. Control-path function does not prove containment or remediation.
- Activity: direct-to-pool calls through the cutoff include 62 withdrawals, 57 repayments, 12 deposits, and one collateral-setting call. Repayments plus withdrawals outnumber deposits 119:12 by count. A broader event view contains one successful liquidation, correcting the provisional direct-call scope.
- Liquidity: at block 27,431,533 (`2026-09-01T03:58:05Z`), a 1,000 USDC-reference spot-notional PHIAT sale quoted 266.731035 on PulseX V2 and 98.477353 on PulseX V1. These were read-only venue-specific quotes; no swap occurred.
- Unresolved: incident cause, loss, reserve-liability reconciliation, bad debt, solvency, user health exposure, remediation completeness, keeper-price provenance, oracle accuracy/freshness, reopening rationale, and broader market absorption.
- Safety: frozen PRVX rc.2 and existing source/production authority remain unchanged. No deployment, D1 write, reader promotion, service wake, portfolio, equity, wallet, order, transaction, or execution change occurred.

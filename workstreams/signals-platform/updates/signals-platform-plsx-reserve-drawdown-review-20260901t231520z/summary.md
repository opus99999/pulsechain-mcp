# PLSX reserve drawdown: sequential cash reduction and bounded disposition

## Approved summary

Across two sequential, incremental, non-overlapping windows, thirteen successful LendingPool withdrawals reduced the underlying PLSX cash held by the phPLSX aToken contract `0x2242e5Fa475b07Cc6D8E88cbE237F3cA3BfA9Be0` by exactly `3,219,744,873.947283954418488524 PLSX`, or `11.307983356091%` of its opening balance. Five direct recipient EOAs received the withdrawals. Through fixed cutoff block 27,438,234 (`2026-09-01T23:07:55Z`), receipt evidence proves `219,830,792.419495195443464548 PLSX` of drawdown-linked value was included in confirmed PulseX or Piteas swaps; `2,999,914,081.527788758975023976 PLSX` remained at direct or one secondary unlabeled EOA. The evidence materially reduces PHIAT reserve availability and strengthens the accepted exit-heavy and seller-flow risk posture. It does not prove that the entire drawdown was sold, lost, stolen, bridged, deposited at an exchange, or that PHIAT is insolvent. No PRVX, source, production, portfolio, wallet, order, transaction, or execution state changed.

## Complete final response

**SIGNALS_PLSX_DRAWDOWN_REVIEW_ACCEPTED — SEQUENTIAL_RESERVE_CASH_REDUCTION — BOUNDED_SWAPS_PROVEN — SOLVENCY_UNRESOLVED — NO_EXECUTION_CHANGE**

- Observation `grok-market-liquidity-web-20260901203710514-7e6de7f2f660`: `ACCEPTED_MATERIAL_SIGNAL`; exact delta `665,408,689.725946050243471130 PLSX` across six successful withdrawals.
- Observation `grok-market-liquidity-web-20260901220147276-e3ffafc4b3e6`: `ACCEPTED_MATERIAL_SIGNAL`; exact additional delta `2,554,336,184.221337904175017394 PLSX` across seven later successful withdrawals.
- Relationship: sequential, incremental, and non-overlapping. The second pre-balance equals the first post-balance; combined double count is zero.
- Source account: phPLSX aToken / Phiat interest-bearing PLSX contract `0x2242e5Fa475b07Cc6D8E88cbE237F3cA3BfA9Be0`, not the LendingPool proxy treasury balance.
- Direct recipients: five unlabeled EOAs. Receipt evidence proves `117,000,000 PLSX` was swapped through PulseX and the newly withdrawn `102,830,792.419495195443464548 PLSX` at another recipient was included in a full-balance Piteas swap.
- Retained state: `2,999,914,081.527788758975023976 PLSX` remained at direct or one secondary unlabeled EOA through cutoff.
- Risk effect: PHIAT underlying PLSX cash fell `11.307983356091%`; reserve availability declined materially and realized seller-flow evidence strengthens the accepted exit-heavy posture.
- Limits: no bridge use, liquidity supply, public exchange deposit, loss, theft, common recipient control, full-drawdown sale, protocol-wide market impact, or insolvency conclusion is established.
- Safety: PRVX rc.2, source, production, portfolio, equity, wallet, order, transaction, and execution authority remain unchanged.

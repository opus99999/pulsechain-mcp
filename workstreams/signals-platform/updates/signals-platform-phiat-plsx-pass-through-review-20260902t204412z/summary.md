# PHIAT incident PLSX pass-through and downstream disposition review

## Approved summary

Independent read-only verification confirms the exact 843,579,441.647005259136001133 PLSX incident-associated pass-through, a full PulseX swap into 7,847.337744 USDC token units, and HomeOmnibridge initiation. The flow is separate from the accepted phPLSX drawdown; double-count amount is zero. Identity and protected state are unchanged.

## Complete final response

**PHIAT INCIDENT PLSX PASS-THROUGH CONFIRMED — DOWNSTREAM SWAP AND BRIDGE INITIATION VERIFIED — SEPARATE FROM PHPLSX DRAWDOWN**

- Source contract: `0x60719573BEAa21421a92D86657866121c8b21892`; narrow role: target-created, target-gated, unverified execution/consolidation helper.
- Target: `0x8f56AA97ebef8080144FB21224E46a5D85657C23`; destination: `0xB00d08E09FA48c2E1D48ac3EdE2fFea354341215`.
- Exact amount: `843,579,441.647005259136001133 PLSX`; forwarded unchanged after exactly 40 seconds; target balance returned to zero.
- Destination swapped the full amount through verified PulseX routes for `7,847.337744 USDC` token units and initiated HomeOmnibridge transfers. The second transfer commingled `1.084314 USDC` from a later unrelated swap, so exact net destination-chain attribution is bounded.
- No lending position or public exchange deposit is proven.
- Relationship to the accepted `3,219,744,873.947283954418488524 PLSX` phPLSX drawdown: `SEPARATE`; double-count amount: `0`.
- Identity conclusion unchanged; no Atropa connection, beneficial ownership, common control, protocol administration, or authenticated control is inferred.
- Investor posture remains `OBSERVATION_ONLY_NO_SUPPORTED_NEW_ENTRY` until Investor Intelligence independently imports this material Signals update.
- Protected-state delta: `0`.

# PHIAT Trust Manifest Signing Interface

This is a boundary contract for a standalone operator signing flow. It is not
registered as an MCP tool and must not run inside MCP tool execution.

The signer may:

- Read an unsigned `phiat-execution-trust-v1` candidate manifest file.
- Validate the strict `PHIAT_TRUST_CANONICAL_JSON_V1` schema.
- Recompute `manifestId` and `manifestFingerprint`.
- Display the full human review report, including records, selectors,
  constraints, expiration, graph fingerprint, bundle fingerprint, and prohibited
  operations.
- Require explicit operator confirmation.
- Request an Ed25519 signature over the versioned binary signature frame from an
  external key provider.
- Write a signed-manifest wrapper.
- Report signed-manifest authorization separately from live transaction
  execution authority.

The signer must not:

- Generate or store a live operator private key in this repository.
- Print a private key.
- Accept a private key through command-line arguments.
- Place a private key in an environment variable.
- Register as an MCP tool.
- Access any wallet signing key.
- Sign blockchain transactions.
- Submit, broadcast, or execute blockchain transactions.
- Report live execution authority as valid without a fresh exact current
  transaction trace and configured clear revocation state.

Future signing providers should prefer OS-protected key storage,
hardware-backed keys, or offline removable media. Tests may use temporary
test-only Ed25519 keys.

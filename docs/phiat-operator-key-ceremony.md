# PHIAT Operator Key Ceremony

This ceremony signs PHIAT execution-trust manifests without letting the operator
signing key enter Node, Codex, MCP, the repository, an environment variable, or
an agent wallet directory.

## Threat Model

The trust manifest is an approval artifact for a narrow execution graph. A
compromised MCP process, modified manifest, reordered authority set, replayed
manifest, altered signature frame, stale router, stale manager, or changed pool
state must not gain authority. The offline signer limits the online MCP process
to producing unsigned evidence, exporting deterministic bytes, and verifying a
detached signature created elsewhere.

## Key Separation

The PHIAT trust-approval key is not a blockchain wallet key. Never reuse a
wallet key, agent-wallet key, seed phrase, mnemonic, or account recovery secret
as the trust-approval key. A valid trust signature can only make a shadow
certificate say that a later separate execution layer may be eligible; it does
not sign or broadcast a blockchain transaction.

## Offline Key Generation

Run key generation manually outside Codex, ChatGPT, and MCP. Keep the private
key outside this repository and outside OneDrive or any automatic
synchronization folder. Prefer encrypted removable media, hardware-backed
storage, or an offline machine. Use a strong passphrase and keep a separate
offline backup.

Git for Windows usually ships OpenSSL at:

```powershell
C:\Program Files\Git\usr\bin\openssl.exe
```

Example external commands:

```powershell
openssl genpkey `
  -algorithm ED25519 `
  -aes-256-cbc `
  -out operator-private.pem

openssl pkey `
  -in operator-private.pem `
  -pubout `
  -out operator-public.pem

openssl pkey `
  -in operator-private.pem `
  -pubout `
  -outform DER `
  -out operator-public.spki.der
```

The operator must perform these manually outside Codex. Never paste the key or
passphrase into Codex, ChatGPT, MCP, or a shell command. If the clipboard is used
for non-secret manifest material, clear it after use.

## Public-Key Configuration

The public SPKI DER file is not secret, but configuration still requires
operator review.

```powershell
npm.cmd run build
node scripts/phiat-trust-public-key-info.mjs `
  --public-key-spki-der operator-public.spki.der
```

The helper prints:

- derived `keyId`
- `algorithm=Ed25519`
- `spkiDerBase64`
- `status=ACTIVE`
- `allowedManifestVersions=["phiat-execution-trust-v1"]`
- `allowedChainIds=[369]`

Review the output before adding it to the operator public-key registry.

## Candidate Manifest Generation

Use the MCP candidate tool to produce an unsigned manifest candidate. The
candidate must include the intended derived `operatorPublicKeyId`. If the
candidate contains the placeholder `operator-key-id-required`, regenerate it
with the reviewed public-key ID before exporting a frame.

The candidate is not an approval. It has no execution authority without a valid
operator signature and a matching live execution graph.

## Review Procedure

Before signing, review:

- chain ID
- manifest version and ID
- manifest fingerprint
- historical graph and bundle fingerprints
- router address and runtime hash
- SwapManager address, runtime hash, and storage layout
- every record address, role, code hash, approved selector, and call type
- parent and caller constraints
- delegatecall contexts
- pool factories, token pairs, fee tiers, and tick spacing
- allowed graph edges
- prohibited operations
- approval and expiration times or blocks
- residual risks
- expected operator public-key ID

Use short expirations. Any router hash or manager hash change invalidates the
manifest immediately. A changed execution graph requires a new manifest.

## Frame Export

Run after `npm.cmd run build`:

```powershell
node scripts/phiat-trust-export-frame.mjs `
  --manifest unsigned-candidate.json `
  --out-dir ceremony-out
```

The exporter writes only non-secret signing materials:

- `canonical-manifest.json`
- `signing-frame.bin`
- `manifest-fingerprint.txt`
- `operator-review.md`
- `signing-metadata.json`

It refuses to overwrite existing files unless `--force` is supplied.

## External Signature

The detached signature is created by an external signer. Do not run this from
Codex.

```powershell
openssl pkeyutl `
  -sign `
  -rawin `
  -inkey operator-private.pem `
  -in signing-frame.bin `
  -out signature.bin
```

The private key path belongs only to the external OpenSSL process. Keep it
outside the repository, outside OneDrive, and outside any MCP or agent-wallet
storage. Never use the blockchain wallet key as the trust-approval key.

## Signed Wrapper Assembly

After the external signature exists, assemble the signed wrapper:

```powershell
node scripts/phiat-trust-assemble-signed-manifest.mjs `
  --manifest unsigned-candidate.json `
  --frame ceremony-out\signing-frame.bin `
  --signature signature.bin `
  --public-key-spki-der operator-public.spki.der `
  --out signed-manifest.json
```

The assembler accepts only public SPKI DER, checks the signature length, derives
the operator public-key ID, reconstructs the signing frame independently,
compares the provided frame byte-for-byte, verifies the Ed25519 signature, writes
the wrapper only if verification passes, and verifies the written wrapper again.

## MCP Verification

The MCP verifier independently recomputes canonical bytes, manifest ID,
fingerprint, key ID, and signature frame. It does not trust the assembler result
or any raw approval boolean.

`phiat_shadow_buy` remains read-only. A valid signed manifest only allows the
shadow certificate to mark the exact live graph eligible for a later separate
execution layer when all live graph checks pass.

## Revocation

Prepare candidate revocation entries for operator review:

```powershell
node scripts/phiat-trust-revocation-entry.mjs `
  --manifest-fingerprint 0x... `
  --reason "operator rotation"

node scripts/phiat-trust-revocation-entry.mjs `
  --key-id 0x... `
  --reason "key retired"
```

The helper prints a candidate entry only. MCP does not create or apply
revocations automatically.

## Rotation, Loss, And Recovery

Rotate the trust key when an operator changes, storage is suspected stale, or a
review policy changes. Revoke the retired key ID and issue new manifests under
the new key ID. If the signing key is lost, revoke its key ID if possible and
create a new key ceremony. Existing unexpired manifests signed by the lost key
should be treated as needing explicit operator review.

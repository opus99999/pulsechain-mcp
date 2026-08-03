#!/usr/bin/env node
const args = parseArgs(process.argv.slice(2), {
  optional: ["manifest-fingerprint", "key-id", "reason", "revoked-at"],
});

const {
  manifestRevocationEntry,
  keyRevocationEntry,
} = await importOfflineHelpers();

const revokedAt = args["revoked-at"] ?? new Date().toISOString();
const reason = args.reason ?? "operator-review-required";
let entry;
if (args["manifest-fingerprint"] && args["key-id"]) {
  usage("Choose either --manifest-fingerprint or --key-id, not both");
}
if (args["manifest-fingerprint"]) {
  entry = manifestRevocationEntry(args["manifest-fingerprint"], reason, revokedAt);
} else if (args["key-id"]) {
  entry = keyRevocationEntry(args["key-id"], reason, revokedAt);
} else {
  usage("Missing --manifest-fingerprint or --key-id");
}

process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);

async function importOfflineHelpers() {
  try {
    return await import("../dist/tools/analytics/phiat-shadow-buy/offlineTrustSigner.js");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      error: "Build output not found. Run npm.cmd run build before using this script.",
      detail: error instanceof Error ? error.message : String(error),
    }) + "\n");
    process.exit(1);
  }
}

function parseArgs(argv, schema) {
  const out = {};
  const allowed = new Set(schema.optional);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) usage();
    const key = token.slice(2);
    if (!allowed.has(key)) usage(`Unknown option --${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) usage(`Missing value for --${key}`);
    out[key] = value;
    i += 1;
  }
  return out;
}

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: node scripts/phiat-trust-revocation-entry.mjs --manifest-fingerprint 0x... [--reason text] [--revoked-at iso]\n" +
      "   or: node scripts/phiat-trust-revocation-entry.mjs --key-id 0x... [--reason text] [--revoked-at iso]\n",
  );
  process.exit(1);
}

#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = parseArgs(process.argv.slice(2), { required: ["public-key-spki-der"] });
const { publicKeyRegistryInfoFromSpkiDer } = await importOfflineHelpers();
const publicSpkiDer = await readFile(resolve(args["public-key-spki-der"]));
const info = publicKeyRegistryInfoFromSpkiDer(publicSpkiDer);

process.stdout.write([
  `keyId=${info.keyId}`,
  `algorithm=${info.algorithm}`,
  `spkiDerBase64=${info.spkiDerBase64}`,
  `status=${info.status}`,
  `allowedManifestVersions=${JSON.stringify(info.allowedManifestVersions)}`,
  `allowedChainIds=${JSON.stringify(info.allowedChainIds)}`,
  "",
  JSON.stringify(info.registryEntry, null, 2),
  "",
].join("\n"));

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
  const allowed = new Set(schema.required);
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
  for (const key of schema.required) {
    if (!out[key]) usage(`Missing --${key}`);
  }
  return out;
}

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: node scripts/phiat-trust-public-key-info.mjs --public-key-spki-der operator-public.spki.der\n",
  );
  process.exit(1);
}

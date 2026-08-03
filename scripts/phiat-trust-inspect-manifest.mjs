#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = parseArgs(process.argv.slice(2), {
  required: ["input"],
  optional: ["public-key-spki-der", "current-block", "now"],
});

const { inspectOfflineTrustManifest } = await importOfflineHelpers();
const inputText = await readFile(resolve(args.input), "utf8");
const publicSpkiDer = args["public-key-spki-der"]
  ? await readFile(resolve(args["public-key-spki-der"]))
  : undefined;
const nowMs = args.now ? Date.parse(args.now) : undefined;
if (args.now && !Number.isFinite(nowMs)) throw new Error("--now must be an ISO timestamp");

const result = inspectOfflineTrustManifest({
  inputText,
  publicSpkiDer,
  nowMs,
  currentBlock: args["current-block"] ?? null,
});
process.stdout.write(`${result.report}\n`);

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
  const allowed = new Set([...schema.required, ...schema.optional]);
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
    "Usage: node scripts/phiat-trust-inspect-manifest.mjs --input manifest.json [--public-key-spki-der operator-public.spki.der] [--current-block n] [--now iso]\n",
  );
  process.exit(1);
}

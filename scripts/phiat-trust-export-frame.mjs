#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2), {
  required: ["manifest", "out-dir"],
  optional: ["force"],
});

const {
  exportOfflineSigningMaterials,
} = await importOfflineHelpers();

const manifestPath = resolve(args.manifest);
const outDir = resolve(args["out-dir"]);
const force = args.force === "true";
const inputText = await readFile(manifestPath, "utf8");
const materials = exportOfflineSigningMaterials(inputText);

await mkdir(outDir, { recursive: true });
await writeOutput(join(outDir, "canonical-manifest.json"), materials.canonicalManifestJson, force);
await writeOutput(join(outDir, "signing-frame.bin"), materials.signingFrame, force);
await writeOutput(join(outDir, "manifest-fingerprint.txt"), `${materials.manifestFingerprint}\n`, force);
await writeOutput(join(outDir, "operator-review.md"), materials.operatorReviewMarkdown, force);
await writeOutput(join(outDir, "signing-metadata.json"), materials.signingMetadataJson, force);

process.stdout.write(JSON.stringify({
  ok: true,
  outDir,
  manifestId: materials.manifest.manifestId,
  manifestFingerprint: materials.manifestFingerprint,
  operatorPublicKeyId: materials.manifest.operatorPublicKeyId,
  files: [
    "canonical-manifest.json",
    "signing-frame.bin",
    "manifest-fingerprint.txt",
    "operator-review.md",
    "signing-metadata.json",
  ],
}, null, 2) + "\n");

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

async function writeOutput(path, data, force) {
  try {
    await writeFile(path, data, { flag: force ? "w" : "wx" });
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw new Error(`Refusing to overwrite ${path}; pass --force to replace ceremony output.`);
    }
    throw error;
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
    if (key === "force") {
      out[key] = "true";
      continue;
    }
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
    "Usage: node scripts/phiat-trust-export-frame.mjs --manifest unsigned.json --out-dir out [--force]\n",
  );
  process.exit(1);
}

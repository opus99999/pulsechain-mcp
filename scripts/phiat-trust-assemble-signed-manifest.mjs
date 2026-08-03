#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = parseArgs(process.argv.slice(2), {
  required: ["manifest", "frame", "signature", "public-key-spki-der", "out"],
  optional: ["force", "current-block", "now"],
});

const {
  assembleOfflineSignedWrapper,
  inspectOfflineTrustManifest,
} = await importOfflineHelpers();

const manifestPath = resolve(args.manifest);
const framePath = resolve(args.frame);
const signaturePath = resolve(args.signature);
const publicKeyPath = resolve(args["public-key-spki-der"]);
const outPath = resolve(args.out);
const force = args.force === "true";
const nowMs = args.now ? Date.parse(args.now) : undefined;
if (args.now && !Number.isFinite(nowMs)) throw new Error("--now must be an ISO timestamp");

const manifestText = await readFile(manifestPath, "utf8");
const providedFrame = await readFile(framePath);
const signatureBytes = await readFile(signaturePath);
const publicSpkiDer = await readFile(publicKeyPath);
const result = assembleOfflineSignedWrapper({
  manifestText,
  providedFrame,
  signatureBytes,
  publicSpkiDer,
  nowMs,
  currentBlock: args["current-block"] ?? null,
});

await writeOutput(outPath, `${JSON.stringify(result.wrapper, null, 2)}\n`, force);

const written = await readFile(outPath, "utf8");
const postWrite = inspectOfflineTrustManifest({
  inputText: written,
  publicSpkiDer,
  nowMs,
  currentBlock: args["current-block"] ?? null,
});
if (!postWrite.verification?.signatureValid || postWrite.verification.executionAuthority !== "VALID") {
  throw new Error(`POST_WRITE_VERIFICATION_FAILED:${postWrite.verification?.validationErrors.join(",") ?? "unknown"}`);
}

process.stdout.write(JSON.stringify({
  ok: true,
  out: outPath,
  manifestFingerprint: result.wrapper.manifestFingerprint,
  operatorPublicKeyId: result.wrapper.operatorPublicKeyId,
  signatureValid: result.verification.signatureValid,
  executionAuthority: result.verification.executionAuthority,
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
      throw new Error(`Refusing to overwrite ${path}; pass --force to replace signed wrapper.`);
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
    "Usage: node scripts/phiat-trust-assemble-signed-manifest.mjs --manifest unsigned.json --frame signing-frame.bin --signature signature.bin --public-key-spki-der operator-public.spki.der --out signed.json [--current-block n] [--now iso] [--force]\n",
  );
  process.exit(1);
}

#!/usr/bin/env node

import { createHash } from "node:crypto";

const REPOSITORY = "opus99999/pulsechain-mcp";
const REPOSITORY_ID = "1320639709";
const REPOSITORY_OWNER = "opus99999";
const REPOSITORY_OWNER_ID = "212180323";
const REF = "refs/heads/main";
const ACTIONS_BOT = "github-actions[bot]";
const ACTIONS_BOT_ID = 41898282;
const ACTIONS_APP_ID = 15368;
const ACTIONS_APP_SLUG = "github-actions";
const AUDIENCE = "pulsechain-control-room-trusted-team-receipt-projector-v1";
const CONTROL_ROOM_ENDPOINT = "https://pulsechain-research-control-room.brohexphiat.chatgpt.site/api/v1/trusted-team/receipt-proofs/github";
const RECEIPT_SCHEMA = "pulsechain-trusted-team-publication-receipt@1.0.0";
const ENVELOPE_SCHEMA = "pulsechain-trusted-team-receipt-proof-envelope@1.0.0";
const MAX_RESPONSE_BYTES = 262_144;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const WORKSTREAMS = new Set(["signals-platform", "validator-flows", "identity-attribution", "investor-intelligence"]);
const RECEIPT_KEYS = [
  "schema_version", "result", "repository", "workstream_id", "update_id", "update_path",
  "permanent_update_url", "commit", "parent_commit", "initial_repository_head",
  "first_observed_repository_head", "observed_repository_head", "manifest_sha256",
  "artifact_filename", "artifact_sha256", "attempts", "retries", "issue_number",
];

export const HISTORICAL_PROOFS = Object.freeze([
  { issue_number: 27, receipt_comment_id: 5480605173, workstream_id: "validator-flows", update_id: "validator-flows-t01-trace-baseline-v2-sharded-20260831t151625z", publication_commit: "b3d409a67784d5110ec8f780b3ac13db004b7830", parent_commit: "f7c5427d505757fe101ea20ef1c402946152f3aa", manifest_sha256: "sha256:d0b2cf522197c974c14cd0f43f86454f2c19088aeda27d5f161493bae64f5c36", artifact_filename: "PulseChain_Validator_T01_Trace_Baseline_V2_Sharded_20260831T151625Z.zip", artifact_sha256: "sha256:b56aa75e134f8aa28a22b2359daa4dcfa9054f02cec501dfc02d2c664206b472", publication_workflow_run_id: null },
  { issue_number: 29, receipt_comment_id: 5492988722, workstream_id: "signals-platform", update_id: "signals-platform-phiat-post-unpause-risk-20260901t094219z", publication_commit: "60329d975f88c138fa275dd2e606b68c03eefabc", parent_commit: "b3d409a67784d5110ec8f780b3ac13db004b7830", manifest_sha256: "sha256:e711bf6eb0082807f5189b7c411ad3d4d30a7b6a67e220754053eb89867cc010", artifact_filename: "PulseChain_Signals_PHIAT_Post_Unpause_Risk_20260901T094219Z.zip", artifact_sha256: "sha256:ea8294ef3565726ad61882f2799fec50db3f10e0f1cec0c5ba5053b26756fa0e", publication_workflow_run_id: null },
  { issue_number: 32, receipt_comment_id: 5502474739, workstream_id: "investor-intelligence", update_id: "investor-intelligence-plsx-drawdown-dependency-rebase-20260901t235405z", publication_commit: "39437e1ddd582702ce7f879563118dcb6cc2bf2b", parent_commit: "394d97003b428e1d215b7a1a0d26feb63c36ef50", manifest_sha256: "sha256:f4e14b0ab82e5a64429bb63b874e69da101b6eb5349abf8a3e135c8e015cc303", artifact_filename: "PulseChain_Investor_PLSX_Drawdown_Dependency_Rebase_20260901T235405Z.zip", artifact_sha256: "sha256:ca3dfcca4ea34e03b5d4baade3e3a3c1320e23725923d1837f648a655a6155eb", publication_workflow_run_id: null },
  { issue_number: 35, receipt_comment_id: 5516294720, workstream_id: "signals-platform", update_id: "signals-platform-phiat-plsx-pass-through-review-20260902t204412z", publication_commit: "0bab30cba6e763337977eb5e8fce57e16659cf63", parent_commit: "5546830c7b1870f14b26c6a7eac4721a8acb511b", manifest_sha256: "sha256:9781f001720b2c60d0e09e4aaab3b43fab68ecb1c9db2019c2d9ce708f0d99cc", artifact_filename: "PulseChain_Signals_PHIAT_PLSX_Pass_Through_Review_20260902T204412Z.zip", artifact_sha256: "sha256:9d1672314cf26e1e495616046681076e57673acf0a0d9a4611b9aeebd41ac300", publication_workflow_run_id: 33682323420 },
]);

function fail(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  throw error;
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  fail("NONCANONICAL_VALUE");
}

function hash(value) {
  const bytes = typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(code);
  return value;
}

function parseReceipt(body) {
  if (typeof body !== "string" || Buffer.byteLength(body) > 32_000) fail("RECEIPT_BODY_INVALID");
  const match = /^```json\r?\n([\s\S]+)\r?\n```$/.exec(body);
  if (!match) fail("RECEIPT_FENCE_INVALID");
  let receipt;
  try { receipt = JSON.parse(match[1]); } catch { fail("RECEIPT_JSON_INVALID"); }
  return exactObject(receipt, RECEIPT_KEYS, "RECEIPT_FIELDS_INVALID");
}

async function boundedJson(response, code) {
  if (!response.ok) fail(code, String(response.status));
  if (!(response.headers.get("content-type") || "").toLowerCase().includes("application/json")) fail(`${code}_CONTENT_TYPE`);
  const claimed = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(claimed) && claimed > MAX_RESPONSE_BYTES) fail(`${code}_TOO_LARGE`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) fail(`${code}_TOO_LARGE`);
  try { return JSON.parse(text); } catch { fail(`${code}_INVALID_JSON`); }
}

async function github(path, token = process.env.GITHUB_TOKEN) {
  if (!token) fail("GITHUB_TOKEN_REQUIRED");
  return boundedJson(await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    method: "GET",
    redirect: "error",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "pulsechain-trusted-team-receipt-projector/1.0",
      "x-github-api-version": "2022-11-28",
    },
  }), "GITHUB_READ_FAILED");
}

async function content(path, ref, token) {
  const row = await github(`/contents/${encodeURI(path)}?ref=${ref}`, token);
  if (!row || row.type !== "file" || row.encoding !== "base64" || typeof row.content !== "string") fail("GITHUB_CONTENT_INVALID", path);
  return Buffer.from(row.content.replace(/\s/g, ""), "base64");
}

function validateReceipt(receipt, expected) {
  const path = `workstreams/${expected.workstream_id}/updates/${expected.update_id}`;
  if (
    receipt.schema_version !== RECEIPT_SCHEMA || receipt.result !== "ACCEPTED" || receipt.repository !== REPOSITORY ||
    receipt.workstream_id !== expected.workstream_id || receipt.update_id !== expected.update_id || receipt.update_path !== path ||
    receipt.commit !== expected.publication_commit || receipt.parent_commit !== expected.parent_commit ||
    receipt.manifest_sha256 !== expected.manifest_sha256 || receipt.artifact_filename !== expected.artifact_filename ||
    receipt.artifact_sha256 !== expected.artifact_sha256 || receipt.issue_number !== expected.issue_number ||
    !Number.isSafeInteger(receipt.attempts) || receipt.attempts < 1 || !Number.isSafeInteger(receipt.retries) || receipt.retries < 0 ||
    !SHA256.test(receipt.manifest_sha256) || !SHA256.test(receipt.artifact_sha256)
  ) fail("RECEIPT_IDENTITY_MISMATCH");
  return path;
}

async function validateImmutableUpdate(expected, receipt, token) {
  const updatePath = validateReceipt(receipt, expected);
  const commit = await github(`/git/commits/${expected.publication_commit}`, token);
  if (!commit || !GIT_SHA.test(commit.sha || "") || commit.sha !== expected.publication_commit || commit.parents?.length !== 1 || commit.parents[0].sha !== expected.parent_commit || !GIT_SHA.test(commit.tree?.sha || "")) fail("PUBLICATION_COMMIT_MISMATCH");
  const manifestBytes = await content(`${updatePath}/manifest.json`, expected.publication_commit, token);
  if (hash(manifestBytes) !== expected.manifest_sha256) fail("MANIFEST_HASH_MISMATCH");
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { fail("MANIFEST_JSON_INVALID"); }
  if (manifest.schema_version !== "pulsechain-trusted-team-update-manifest@1.0.0" || manifest.workstream_id !== expected.workstream_id || manifest.update_id !== expected.update_id || manifest.artifact?.filename !== expected.artifact_filename || manifest.artifact?.sha256 !== expected.artifact_sha256 || !Array.isArray(manifest.files)) fail("MANIFEST_IDENTITY_MISMATCH");
  const acceptedUpdateFiles = [];
  for (const file of manifest.files) {
    if (!file || typeof file.filename !== "string" || !SHA256.test(file.sha256 || "") || !Number.isSafeInteger(file.byte_size)) fail("MANIFEST_FILE_INVALID");
    const bytes = await content(`${updatePath}/${file.filename}`, expected.publication_commit, token);
    if (bytes.byteLength !== file.byte_size || hash(bytes) !== file.sha256) fail("MANIFEST_FILE_MISMATCH", file.filename);
    acceptedUpdateFiles.push({ filename: file.filename, byte_size: bytes.byteLength, sha256: file.sha256 });
  }
  return { updatePath, repositoryTreeSha: commit.tree.sha, manifestBody: manifestBytes.toString("utf8"), acceptedUpdateFiles };
}

function sourceIdentity() {
  const integer = (value, name) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) fail("GITHUB_CONTEXT_INVALID", name);
    return parsed;
  };
  const workflowRef = process.env.GITHUB_WORKFLOW_REF || "";
  const workflowSha = process.env.GITHUB_WORKFLOW_SHA || process.env.GITHUB_SHA || "";
  if (
    process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.GITHUB_REPOSITORY_ID !== REPOSITORY_ID ||
    process.env.GITHUB_REPOSITORY_OWNER !== REPOSITORY_OWNER || process.env.GITHUB_REPOSITORY_OWNER_ID !== REPOSITORY_OWNER_ID ||
    process.env.GITHUB_REF !== REF || !GIT_SHA.test(workflowSha) || !workflowRef.startsWith(`${REPOSITORY}/.github/workflows/`) || !workflowRef.endsWith(`@${REF}`)
  ) fail("GITHUB_CONTEXT_INVALID");
  return {
    repository: REPOSITORY, repository_id: REPOSITORY_ID, repository_owner: REPOSITORY_OWNER,
    repository_owner_id: REPOSITORY_OWNER_ID, ref: REF, event_name: process.env.GITHUB_EVENT_NAME,
    workflow_ref: workflowRef, workflow_sha: workflowSha, run_id: integer(process.env.GITHUB_RUN_ID, "run_id"),
    run_attempt: integer(process.env.GITHUB_RUN_ATTEMPT, "run_attempt"),
  };
}

async function oidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) fail("OIDC_ENVIRONMENT_UNAVAILABLE");
  const endpoint = new URL(url);
  endpoint.searchParams.set("audience", AUDIENCE);
  const body = await boundedJson(await fetch(endpoint, { headers: { authorization: `Bearer ${requestToken}` }, redirect: "error" }), "OIDC_TOKEN_FAILED");
  if (!body || typeof body.value !== "string" || body.value.length < 100) fail("OIDC_TOKEN_INVALID");
  return body.value;
}

export async function projectTrustedTeamReceipt(expected, options = {}) {
  if (!WORKSTREAMS.has(expected.workstream_id) || !Number.isSafeInteger(expected.issue_number) || !Number.isSafeInteger(expected.receipt_comment_id) || !GIT_SHA.test(expected.publication_commit || "") || !GIT_SHA.test(expected.parent_commit || "") || !SHA256.test(expected.manifest_sha256 || "") || !SHA256.test(expected.artifact_sha256 || "")) fail("EXPECTED_PROOF_INVALID");
  const token = options.githubToken || process.env.GITHUB_TOKEN;
  const comment = await github(`/issues/comments/${expected.receipt_comment_id}`, token);
  const app = comment.performed_via_github_app;
  if (comment.id !== expected.receipt_comment_id || comment.issue_url !== `https://api.github.com/repos/${REPOSITORY}/issues/${expected.issue_number}` || comment.user?.login !== ACTIONS_BOT || comment.user?.id !== ACTIONS_BOT_ID || (app != null && (app.id !== ACTIONS_APP_ID || app.slug !== ACTIONS_APP_SLUG))) fail("RECEIPT_COMMENT_IDENTITY_MISMATCH");
  const receipt = parseReceipt(comment.body);
  const immutable = await validateImmutableUpdate(expected, receipt, token);
  const source = sourceIdentity();
  const duplicateSerialization = ["trusted-team-receipt-proof-v1", REPOSITORY_ID, expected.issue_number, expected.receipt_comment_id, expected.workstream_id, expected.update_id, expected.publication_commit, expected.manifest_sha256, expected.artifact_sha256].join("|");
  const duplicateKey = hash(duplicateSerialization);
  const core = {
    proof_event_type: "VERIFIED", repository: REPOSITORY, repository_id: REPOSITORY_ID,
    workstream_id: expected.workstream_id, update_id: expected.update_id, update_path: immutable.updatePath,
    issue_number: expected.issue_number, receipt_comment_id: expected.receipt_comment_id,
    receipt_comment_author_login: ACTIONS_BOT, receipt_comment_author_id: ACTIONS_BOT_ID,
    receipt_body: comment.body, publication_commit: expected.publication_commit, parent_commit: expected.parent_commit,
    manifest_sha256: expected.manifest_sha256, manifest_body: immutable.manifestBody,
    artifact_filename: expected.artifact_filename, artifact_sha256: expected.artifact_sha256,
    accepted_update_files: immutable.acceptedUpdateFiles, repository_tree_sha: immutable.repositoryTreeSha,
    publication_workflow_run_id: expected.publication_workflow_run_id ?? null,
    publication_workflow_result: "SUCCESS", canonical_duplicate_key: duplicateKey,
  };
  const proof = { ...core, proof_event_id: `trusted-team-receipt-proof-event-${duplicateKey.slice(7)}`, receipt_body_sha256: hash(comment.body), content_sha256: hash(core), created_at_utc: new Date().toISOString() };
  const envelope = { schema_version: ENVELOPE_SCHEMA, proof, source };
  const identityToken = options.oidcToken || await oidcToken();
  const response = await fetch(options.endpoint || CONTROL_ROOM_ENDPOINT, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${identityToken}`, "content-type": "application/json" }, body: JSON.stringify(envelope) });
  const machine = await boundedJson(response, "CONTROL_ROOM_PROOF_REJECTED");
  if (machine?.schema_version !== "pulsechain-trusted-team-receipt-proof-receipt@1.0.0" || machine.accepted !== true || machine.proof_event_id !== proof.proof_event_id || machine.canonical_duplicate_key !== duplicateKey || machine.content_sha256 !== proof.content_sha256) fail("CONTROL_ROOM_MACHINE_RECEIPT_INVALID");
  return machine;
}

async function main() {
  if (process.argv[2] === "--historical-backfill" && process.argv.length === 3) {
    const first = [];
    for (const expected of HISTORICAL_PROOFS) first.push(await projectTrustedTeamReceipt(expected));
    if (first.some((receipt) => receipt.replayed)) fail("BACKFILL_EXPECTED_NEW_PROOF");
    const replay = [];
    for (const expected of HISTORICAL_PROOFS) replay.push(await projectTrustedTeamReceipt(expected));
    if (replay.some((receipt) => !receipt.replayed || receipt.new_events !== 0)) fail("BACKFILL_REPLAY_FAILED");
    process.stdout.write(`${JSON.stringify({ result: "ACCEPTED", initial_verified_proof_count: 4, backfill_failed_proof_count: 0, backfill_replay_new_proof_count: 0, proof_event_ids: first.map((item) => item.proof_event_id) })}\n`);
    return;
  }
  fail("INVALID_PROJECTOR_ARGUMENT");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ result: "RECEIPT_PROJECTION_FAILED", code: error.code || "RECEIPT_PROJECTION_FAILED", detail: String(error.message || error).slice(0, 500) })}\n`);
    process.exitCode = 1;
  });
}

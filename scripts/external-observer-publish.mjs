import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const PROJECT_ID = "pulsechain-investor-intelligence";
const REPOSITORY = "opus99999/pulsechain-mcp";
const REPOSITORY_ID = "1320639709";
const OWNER_ID = "212180323";
const ACTOR = "opus99999";
const ACTOR_ID = "212180323";
const REF = "refs/heads/main";
const WORKFLOW = ".github/workflows/trusted-team-external-observers.yml";
const TITLE_PREFIX = "EXTERNAL OBSERVER SUBMISSION —";
const OBSERVATION_SCHEMA = "pulsechain-external-observation@1.0.0";
const PUBLICATION_SCHEMA = "pulsechain-external-observer-publication@1.0.0";
const LATEST_SCHEMA = "pulsechain-external-observer-latest@1.0.0";
const INDEX_SCHEMA = "pulsechain-external-observer-index@1.0.0";
const MANIFEST_SCHEMA = "pulsechain-external-observation-manifest@1.0.0";
const SOURCES_SCHEMA = "pulsechain-external-observation-sources@1.0.0";
const MACHINE_RECEIPT_SCHEMA = "pulsechain-external-observer-machine-receipt@1.0.0";
const MACHINE_RECEIPT_MARKER = `<!-- ${MACHINE_RECEIPT_SCHEMA} -->`;
const CLASSIFICATION = "PENDING_SPECIALIST_REVIEW";
const OBSERVERS = ["grok-x-protocol", "grok-infrastructure-incidents", "grok-market-liquidity", "grok-identity-evidence", "grok-red-team"];
const WORKSTREAMS = ["signals-platform", "validator-flows", "identity-attribution", "investor-intelligence"];
const SOURCE_CLASSES = ["X_POST", "X_THREAD", "OFFICIAL_WEB", "STATUS_PAGE", "GITHUB", "LEGAL_OR_CORPORATE_RECORD", "SIGNED_MESSAGE", "DETERMINISTIC_CHAIN_ALERT", "PUBLIC_SECONDARY_SOURCE", "MULTI_SOURCE"];
const EVIDENCE_STATES = ["PROVISIONAL_EXTERNAL_SIGNAL", "EXTERNAL_REVIEW_FINDING", "SOURCE_CHANGE_ALERT", "NEGATIVE_SEARCH_RESULT"];
const MATERIALITY = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const CONFIDENCE = ["LOW", "MEDIUM", "HIGH"];
const COMMIT = /^[0-9a-f]{40}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const OBSERVATION_ID = /^[a-z0-9-]{20,120}$/;
const NONCE = /^[A-Za-z0-9._:-]{16,128}$/;
const SECRET = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|(?:api[_-]?key|access[_-]?token|private[_-]?key|seed[_-]?phrase|mnemonic)\s*[:=]\s*["']?[^\s"']{8,})/i;

export class ExternalObserverPublishError extends Error {
  constructor(code, detail, rebaseRequired = false) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
    this.rebase_required = rebaseRequired;
  }
}

function fail(code, detail, rebase = false) { throw new ExternalObserverPublishError(code, detail, rebase); }
function plain(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype); }
function exactKeys(value, keys, label) {
  if (!plain(value)) fail("INVALID_OBJECT", label);
  const expected = new Set(keys);
  const extra = Object.keys(value).find((key) => !expected.has(key));
  const missing = keys.find((key) => !(key in value));
  if (extra || missing) fail("SCHEMA_FIELD_MISMATCH", `${label}:${extra ? `extra:${extra}` : `missing:${missing}`}`);
}
function safeText(value, label, maximum, allowEmpty = false) {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0") || (!allowEmpty && !value.trim())) fail("INVALID_TEXT", label);
  return value;
}
function iso(value, label, nullable = false) {
  if (nullable && value === null) return null;
  const result = safeText(value, label, 40);
  if (!result.endsWith("Z") || Number.isNaN(Date.parse(result))) fail("INVALID_TIMESTAMP", label);
  return result;
}
function array(value, label, maximum, validate, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail("INVALID_ARRAY", label);
  const result = value.map(validate);
  if (new Set(result.map((item) => typeof item === "string" ? item : JSON.stringify(item))).size !== result.length) fail("DUPLICATE_ARRAY_ITEM", label);
  return result;
}
export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  fail("NONCANONICAL_JSON_VALUE", "document");
}
function jsonBytes(value) { return Buffer.from(`${canonicalJson(value)}\n`, "utf8"); }
function sha256(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function validateHash(value, label) { if (typeof value !== "string" || !HASH.test(value)) fail("INVALID_SHA256", label); return value; }
function validateStringArray(value, label, maximum, itemMaximum = 500) { return array(value, label, maximum, (item, index) => safeText(item, `${label}[${index}]`, itemMaximum, true)); }

export function validateObservation(value, fixedObserver = null) {
  const fields = ["schema_version", "observation_id", "observer_id", "generated_at_utc", "observed_window", "source_class", "source_records", "claim_summary", "what_changed", "why_material", "materiality", "confidence", "evidence_state", "target_workstreams", "related_assets", "related_addresses", "related_contracts", "related_transactions", "related_update_ids", "specialist_questions", "prohibited_inferences", "duplicate_check", "recheck_at_utc", "adjudication_state", "synthetic_canary", "public_safe", "raw_sensitive_material_included", "content_sha256"];
  exactKeys(value, fields, "observation");
  if (value.schema_version !== OBSERVATION_SCHEMA || !OBSERVATION_ID.test(value.observation_id || "") || !OBSERVERS.includes(value.observer_id) || (fixedObserver && value.observer_id !== fixedObserver)) fail("OBSERVATION_IDENTITY_INVALID", value.observation_id || "missing");
  const generated = iso(value.generated_at_utc, "generated_at_utc");
  exactKeys(value.observed_window, ["from_utc", "to_utc"], "observed_window");
  const from = iso(value.observed_window.from_utc, "observed_window.from_utc");
  const to = iso(value.observed_window.to_utc, "observed_window.to_utc");
  if (Date.parse(from) > Date.parse(to) || Date.parse(to) > Date.parse(generated)) fail("OBSERVED_WINDOW_INVALID", value.observation_id);
  if (!SOURCE_CLASSES.includes(value.source_class)) fail("SOURCE_CLASS_INVALID", value.source_class);
  const sources = array(value.source_records, "source_records", 20, (source, index) => {
    exactKeys(source, ["url", "source_id", "author_or_domain", "published_at_utc", "retrieved_at_utc", "content_sha256", "primary_source", "authenticated_source"], `source_records[${index}]`);
    let url;
    try { url = new URL(safeText(source.url, `source_records[${index}].url`, 2000)); } catch { fail("SOURCE_URL_INVALID", String(source.url)); }
    if (!["http:", "https:"].includes(url.protocol) || typeof source.primary_source !== "boolean" || typeof source.authenticated_source !== "boolean") fail("SOURCE_RECORD_INVALID", String(index));
    return { url: url.toString(), source_id: safeText(source.source_id, `source_records[${index}].source_id`, 160), author_or_domain: safeText(source.author_or_domain, `source_records[${index}].author_or_domain`, 300), published_at_utc: iso(source.published_at_utc, `source_records[${index}].published_at_utc`, true), retrieved_at_utc: iso(source.retrieved_at_utc, `source_records[${index}].retrieved_at_utc`), content_sha256: validateHash(source.content_sha256, `source_records[${index}].content_sha256`), primary_source: source.primary_source, authenticated_source: source.authenticated_source };
  }, 1);
  const claim = safeText(value.claim_summary, "claim_summary", 2000);
  const changed = safeText(value.what_changed, "what_changed", 1000);
  const why = safeText(value.why_material, "why_material", 1000);
  if (claim.length + changed.length + why.length > 4000 || !MATERIALITY.includes(value.materiality) || !CONFIDENCE.includes(value.confidence) || !EVIDENCE_STATES.includes(value.evidence_state)) fail("OBSERVATION_CLASSIFICATION_INVALID", value.observation_id);
  const targets = array(value.target_workstreams, "target_workstreams", 4, (item) => { if (!WORKSTREAMS.includes(item)) fail("TARGET_WORKSTREAM_INVALID", String(item)); return item; }, 1);
  exactKeys(value.duplicate_check, ["checked_observation_ids", "duplicate_of", "canonical_duplicate_key"], "duplicate_check");
  const checked = array(value.duplicate_check.checked_observation_ids, "checked_observation_ids", 100, (item) => { if (!OBSERVATION_ID.test(item || "")) fail("CHECKED_OBSERVATION_ID_INVALID", String(item)); return item; });
  if (value.duplicate_check.duplicate_of !== null && !OBSERVATION_ID.test(value.duplicate_check.duplicate_of || "")) fail("DUPLICATE_OF_INVALID", String(value.duplicate_check.duplicate_of));
  validateHash(value.duplicate_check.canonical_duplicate_key, "canonical_duplicate_key");
  if (value.adjudication_state !== CLASSIFICATION || typeof value.synthetic_canary !== "boolean" || value.public_safe !== true || value.raw_sensitive_material_included !== false) fail("AUTHORITY_OR_PRIVACY_STATE_INVALID", value.observation_id);
  validateHash(value.content_sha256, "content_sha256");
  const { content_sha256: ignored, ...identity } = value;
  if (sha256(Buffer.from(canonicalJson(identity), "utf8")) !== value.content_sha256) fail("CONTENT_HASH_MISMATCH", value.observation_id);
  if (SECRET.test(canonicalJson(value))) fail("PRIVATE_DATA_REJECTED", value.observation_id);
  return { ...value, generated_at_utc: generated, observed_window: { from_utc: from, to_utc: to }, source_records: sources, claim_summary: claim, what_changed: changed, why_material: why, target_workstreams: targets, related_assets: validateStringArray(value.related_assets, "related_assets", 20, 300), related_addresses: validateStringArray(value.related_addresses, "related_addresses", 10, 200), related_contracts: validateStringArray(value.related_contracts, "related_contracts", 10, 200), related_transactions: validateStringArray(value.related_transactions, "related_transactions", 10, 200), related_update_ids: validateStringArray(value.related_update_ids, "related_update_ids", 20, 160), specialist_questions: validateStringArray(value.specialist_questions, "specialist_questions", 10, 500), prohibited_inferences: validateStringArray(value.prohibited_inferences, "prohibited_inferences", 10, 500), duplicate_check: { checked_observation_ids: checked, duplicate_of: value.duplicate_check.duplicate_of, canonical_duplicate_key: value.duplicate_check.canonical_duplicate_key }, recheck_at_utc: iso(value.recheck_at_utc, "recheck_at_utc", true) };
}

export function validatePublicationEnvelope(value) {
  exactKeys(value, ["schema_version", "expected_repository_head", "expected_latest_observation_id", "submission_nonce", "observation"], "publication envelope");
  if (value.schema_version !== PUBLICATION_SCHEMA || !COMMIT.test(value.expected_repository_head || "")) fail("PUBLICATION_ENVELOPE_INVALID", "schema or expected head");
  if (value.expected_latest_observation_id !== null && !OBSERVATION_ID.test(value.expected_latest_observation_id || "")) fail("EXPECTED_LATEST_INVALID", String(value.expected_latest_observation_id));
  if (typeof value.submission_nonce !== "string" || !NONCE.test(value.submission_nonce)) fail("SUBMISSION_NONCE_INVALID", String(value.submission_nonce));
  return { schema_version: PUBLICATION_SCHEMA, expected_repository_head: value.expected_repository_head, expected_latest_observation_id: value.expected_latest_observation_id, submission_nonce: value.submission_nonce, observation: validateObservation(value.observation) };
}

export function validateMachineReceipt(value) {
  const fields = ["schema_version", "issue_number", "observer_id", "observation_id", "submission_nonce", "accepted", "error_code", "expected_head", "parent_commit", "publication_commit", "manifest_sha256", "permanent_url", "workflow_run_id", "attempt", "retries", "generated_at_utc", "rebase_required", "idempotent"];
  exactKeys(value, fields, "machine receipt");
  if (value.schema_version !== MACHINE_RECEIPT_SCHEMA || !Number.isSafeInteger(value.issue_number) || value.issue_number < 1 || typeof value.accepted !== "boolean") fail("INVALID_MACHINE_RECEIPT", "identity");
  if (value.accepted) {
    if (!OBSERVERS.includes(value.observer_id) || !OBSERVATION_ID.test(value.observation_id || "") || !NONCE.test(value.submission_nonce || "") || !COMMIT.test(value.expected_head || "")) fail("INVALID_MACHINE_RECEIPT", "accepted binding");
  } else {
    if (value.observer_id !== null && !OBSERVERS.includes(value.observer_id)) fail("INVALID_MACHINE_RECEIPT", "observer_id");
    if (value.observation_id !== null && !OBSERVATION_ID.test(value.observation_id || "")) fail("INVALID_MACHINE_RECEIPT", "observation_id");
    if (value.submission_nonce !== null && !NONCE.test(value.submission_nonce || "")) fail("INVALID_MACHINE_RECEIPT", "submission_nonce");
    if (value.expected_head !== null && !COMMIT.test(value.expected_head || "")) fail("INVALID_MACHINE_RECEIPT", "expected_head");
  }
  for (const [field, pattern] of [["parent_commit", COMMIT], ["publication_commit", COMMIT], ["manifest_sha256", HASH]]) {
    if (value[field] !== null && (typeof value[field] !== "string" || !pattern.test(value[field]))) fail("INVALID_MACHINE_RECEIPT", field);
  }
  if (value.error_code !== null && (typeof value.error_code !== "string" || value.error_code.length < 1 || value.error_code.length > 160)) fail("INVALID_MACHINE_RECEIPT", "error_code");
  if (value.permanent_url !== null) {
    let url;
    try { url = new URL(value.permanent_url); } catch { fail("INVALID_MACHINE_RECEIPT", "permanent_url"); }
    if (url.protocol !== "https:") fail("INVALID_MACHINE_RECEIPT", "permanent_url");
  }
  if (value.workflow_run_id !== null && (typeof value.workflow_run_id !== "string" || !/^[0-9]{1,32}$/.test(value.workflow_run_id))) fail("INVALID_MACHINE_RECEIPT", "workflow_run_id");
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 0 || value.attempt > 10 || !Number.isSafeInteger(value.retries) || value.retries < 0 || value.retries > value.attempt || typeof value.rebase_required !== "boolean" || typeof value.idempotent !== "boolean" || typeof value.generated_at_utc !== "string" || !value.generated_at_utc.endsWith("Z") || Number.isNaN(Date.parse(value.generated_at_utc))) fail("INVALID_MACHINE_RECEIPT", "attempt metadata");
  if (value.accepted) {
    if (value.error_code !== null || value.publication_commit === null || value.manifest_sha256 === null || value.permanent_url === null || value.rebase_required) fail("INVALID_MACHINE_RECEIPT", "accepted outcome");
  } else if (value.error_code === null || value.publication_commit !== null || value.manifest_sha256 !== null || value.permanent_url !== null || value.idempotent) fail("INVALID_MACHINE_RECEIPT", "rejected outcome");
  return value;
}

export function formatMachineReceiptComment(receipt) {
  return `${MACHINE_RECEIPT_MARKER}\n\`\`\`json\n${canonicalJson(validateMachineReceipt(receipt))}\n\`\`\``;
}

export async function postMachineReceiptComment({ issueNumber, receipt, githubToken, fetchImpl = globalThis.fetch }) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || receipt.issue_number !== issueNumber || typeof githubToken !== "string" || githubToken.length < 20 || typeof fetchImpl !== "function") fail("RECEIPT_COMMENT_CONFIGURATION_INVALID", String(issueNumber));
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${githubToken}`, "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "pulsechain-external-observer-publisher" },
    body: JSON.stringify({ body: formatMachineReceiptComment(receipt) }),
  });
  if (!response?.ok) fail("RECEIPT_COMMENT_FAILED", `HTTP ${response?.status ?? "unknown"}`);
}

function renderObservation(observation, context) {
  const base = `external-observers/observers/${observation.observer_id}/observations/${observation.observation_id}`;
  const observationBytes = jsonBytes(observation);
  const sourcesBytes = jsonBytes({ schema_version: SOURCES_SCHEMA, observation_id: observation.observation_id, sources: observation.source_records });
  const syntheticBanner = observation.synthetic_canary ? "\nSYNTHETIC_CANARY — INFRASTRUCTURE ONLY\n" : "";
  const summaryBytes = Buffer.from(`# ${observation.observation_id}\n\nExternal observer — provisional — specialist review required\n${syntheticBanner}\n## Claim summary\n\n${observation.claim_summary}\n\n## What changed\n\n${observation.what_changed}\n\n## Why it matters\n\n${observation.why_material}\n\n## Target workstreams\n\n${observation.target_workstreams.join("\n")}\n\n## Specialist questions\n\n${observation.specialist_questions.join("\n") || "None recorded."}\n\n## Prohibited inferences\n\n${observation.prohibited_inferences.join("\n") || "None recorded."}\n`, "utf8");
  const governed = [{ filename: "observation.json", bytes: observationBytes }, { filename: "summary.md", bytes: summaryBytes }, { filename: "sources.json", bytes: sourcesBytes }];
  const syntheticCanary = observation.synthetic_canary;
  const manifest = { schema_version: MANIFEST_SCHEMA, project_id: PROJECT_ID, observer_id: observation.observer_id, observation_id: observation.observation_id, classification: CLASSIFICATION, published_at_utc: context.published_at_utc, synthetic_canary: syntheticCanary, files: governed.map(({ filename, bytes }) => ({ filename, byte_size: bytes.byteLength, sha256: sha256(bytes) })), publication: { source_issue_number: context.issue_number, source_issue_url: context.issue_url, actor: ACTOR, actor_id: ACTOR_ID, workflow_ref: context.workflow_ref, workflow_sha: context.workflow_sha } };
  const manifestBytes = jsonBytes(manifest);
  const manifestHash = sha256(manifestBytes);
  const entry = { observation_id: observation.observation_id, observation_path: base, observer_id: observation.observer_id, published_at_utc: context.published_at_utc, generated_at_utc: observation.generated_at_utc, source_class: observation.source_class, materiality: observation.materiality, confidence: observation.confidence, evidence_state: observation.evidence_state, adjudication_state: CLASSIFICATION, target_workstreams: observation.target_workstreams, manifest_sha256: manifestHash, content_sha256: observation.content_sha256, canonical_duplicate_key: observation.duplicate_check.canonical_duplicate_key, synthetic_canary: syntheticCanary };
  return { base, files: new Map([...governed.map(({ filename, bytes }) => [`${base}/${filename}`, bytes]), [`${base}/manifest.json`, manifestBytes]]), manifestHash, entry, latest: { schema_version: LATEST_SCHEMA, project_id: PROJECT_ID, observer_id: observation.observer_id, observation_id: observation.observation_id, observation_path: base, published_at_utc: context.published_at_utc, materiality: observation.materiality, confidence: observation.confidence, evidence_state: observation.evidence_state, adjudication_state: CLASSIFICATION, manifest_sha256: manifestHash, content_sha256: observation.content_sha256, target_workstreams: observation.target_workstreams } };
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => { const result = { code, stdout: stdout.trim(), stderr: stderr.trim() }; if (code === 0 || options.allowFailure) resolvePromise(result); else rejectPromise(Object.assign(new Error(stderr.trim() || `${command} exited ${code}`), { result })); });
  });
}
const git = (root, args, options = {}) => run("git", args, { cwd: root, ...options });
async function readJson(path, label) { try { return JSON.parse(await readFile(path, "utf8")); } catch { fail("INVALID_LEDGER_JSON", label); } }
async function writeNew(path, bytes) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { flag: "wx" }); }

async function repositoryState(root) {
  const status = await git(root, ["status", "--porcelain"]);
  if (status.stdout) fail("DIRTY_CHECKOUT", status.stdout);
  await git(root, ["fetch", "--no-tags", "origin", "main"]);
  const head = (await git(root, ["rev-parse", "refs/remotes/origin/main"])).stdout;
  if (!COMMIT.test(head)) fail("INVALID_REMOTE_HEAD", head);
  return head;
}

async function readAllIndexes(root) {
  const result = [];
  for (const observer of OBSERVERS) {
    const path = resolve(root, `external-observers/observers/${observer}/index.json`);
    const index = await readJson(path, path);
    if (index.schema_version !== INDEX_SCHEMA || index.project_id !== PROJECT_ID || index.observer_id !== observer || !Array.isArray(index.observations)) fail("CORRUPT_OBSERVER_INDEX", observer);
    result.push(...index.observations);
  }
  return result;
}

async function prepareAttempt(root, envelope, context, head) {
  await git(root, ["reset", "--hard", head]);
  const observation = envelope.observation;
  const base = `external-observers/observers/${observation.observer_id}`;
  const latestPath = resolve(root, `${base}/latest.json`);
  const indexPath = resolve(root, `${base}/index.json`);
  const rollupPath = resolve(root, "external-observers/project-rollup.json");
  const registry = await readJson(resolve(root, "external-observers/registry.json"), "observer registry");
  const definition = registry.observers?.find((item) => item.observer_id === observation.observer_id);
  if (!definition || !definition.permitted_source_classes.includes(observation.source_class) || observation.target_workstreams.some((workstream) => !definition.permitted_target_workstreams.includes(workstream))) fail("OBSERVER_SCOPE_REJECTED", observation.observer_id);
  const latest = await readJson(latestPath, "latest");
  const index = await readJson(indexPath, "index");
  const rollup = await readJson(rollupPath, "rollup");
  const allEntries = await readAllIndexes(root);
  const replay = allEntries.find((entry) => entry.observation_id === observation.observation_id);
  if (replay) {
    if (replay.content_sha256 !== observation.content_sha256 || replay.observer_id !== observation.observer_id) fail("OBSERVATION_ID_ALREADY_EXISTS", observation.observation_id);
    const observationBytes = await readFile(resolve(root, `${replay.observation_path}/observation.json`));
    if (!observationBytes.equals(jsonBytes(observation))) fail("OBSERVATION_ID_ALREADY_EXISTS", observation.observation_id);
    const manifestBytes = await readFile(resolve(root, `${replay.observation_path}/manifest.json`));
    if (sha256(manifestBytes) !== replay.manifest_sha256) fail("REPLAY_MANIFEST_MISMATCH", observation.observation_id);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (manifest.observer_id !== observation.observer_id || manifest.observation_id !== observation.observation_id || manifest.synthetic_canary !== observation.synthetic_canary) fail("REPLAY_MANIFEST_MISMATCH", observation.observation_id);
    const publicationCommit = (await git(root, ["log", "-1", "--format=%H", "--", `${replay.observation_path}/manifest.json`])).stdout;
    if (!COMMIT.test(publicationCommit)) fail("REPLAY_COMMIT_MISSING", observation.observation_id);
    const parentCommit = (await git(root, ["rev-parse", `${publicationCommit}^`])).stdout;
    return { idempotent: true, entry: replay, commit: publicationCommit, parent: parentCommit };
  }
  if (envelope.expected_repository_head !== head) fail("EXPECTED_HEAD_STALE", `expected ${envelope.expected_repository_head}; current ${head}`, true);
  if (latest.observation_id !== envelope.expected_latest_observation_id || (index.observations?.[0]?.observation_id ?? null) !== latest.observation_id || rollup.latest_observation_ids?.[observation.observer_id] !== latest.observation_id) fail("OBSERVER_HEAD_ADVANCED", observation.observer_id, true);
  if (allEntries.some((entry) => entry.content_sha256 === observation.content_sha256 || entry.canonical_duplicate_key === observation.duplicate_check.canonical_duplicate_key)) fail("DUPLICATE_OBSERVATION", observation.observation_id);
  const cutoff = Date.parse(context.published_at_utc) - 60 * 60 * 1000;
  const recent = index.observations.filter((entry) => Date.parse(entry.published_at_utc) > cutoff);
  if (recent.length >= 6) {
    const criticalBypass = observation.materiality === "CRITICAL" && observation.source_records.some((source) => source.primary_source) && !recent.some((entry) => entry.content_sha256 === observation.content_sha256);
    if (!criticalBypass) fail("OBSERVER_RATE_LIMIT", observation.observer_id);
  }
  const rendered = renderObservation(observation, context);
  const exists = await git(root, ["cat-file", "-e", `${head}:${rendered.base}`], { allowFailure: true });
  if (exists.code === 0) fail("OBSERVATION_PATH_ALREADY_EXISTS", rendered.base);
  for (const [path, bytes] of rendered.files) await writeNew(resolve(root, path), bytes);
  await writeFile(latestPath, jsonBytes(rendered.latest));
  await writeFile(indexPath, jsonBytes({ ...index, observations: [rendered.entry, ...index.observations] }));
  await writeFile(rollupPath, jsonBytes({ ...rollup, generated_at_utc: context.published_at_utc, latest_observation_ids: { ...rollup.latest_observation_ids, [observation.observer_id]: observation.observation_id } }));
  const tracked = (await git(root, ["diff", "--name-only"])).stdout.split("\n").filter(Boolean);
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard"])).stdout.split("\n").filter(Boolean);
  const changed = [...new Set([...tracked, ...untracked])];
  const allowed = new Set([...rendered.files.keys(), `${base}/latest.json`, `${base}/index.json`, "external-observers/project-rollup.json"]);
  if (changed.length !== allowed.size || changed.some((path) => !allowed.has(path)) || changed.some((path) => path.startsWith("workstreams/"))) fail("PATH_ISOLATION_FAILED", changed.join(","));
  await git(root, ["add", "--", ...[...allowed].sort()]);
  await git(root, ["commit", "-m", `external-observer(${observation.observer_id}): ${observation.observation_id}`]);
  const commit = (await git(root, ["rev-parse", "HEAD"])).stdout;
  return { idempotent: false, entry: rendered.entry, commit, parent: head };
}

export function validateGitHubContext(event, env) {
  if (!plain(event) || !plain(event.issue) || !plain(event.repository) || !plain(event.sender)) fail("INVALID_GITHUB_EVENT", "event");
  if (env.GITHUB_REPOSITORY !== REPOSITORY || String(env.GITHUB_REPOSITORY_ID) !== REPOSITORY_ID || String(env.GITHUB_REPOSITORY_OWNER_ID) !== OWNER_ID || env.GITHUB_REF !== REF || env.GITHUB_EVENT_NAME !== "issues" || env.GITHUB_EVENT_ACTION !== "opened" || env.GITHUB_ACTOR !== ACTOR || String(env.GITHUB_ACTOR_ID) !== ACTOR_ID || event.action !== "opened" || event.repository.full_name !== REPOSITORY || String(event.repository.id) !== REPOSITORY_ID || String(event.repository.owner?.id) !== OWNER_ID || event.sender.login !== ACTOR || String(event.sender.id) !== ACTOR_ID || event.issue.user?.login !== ACTOR || String(event.issue.user?.id) !== ACTOR_ID) fail("GITHUB_IDENTITY_MISMATCH", "repository or actor");
  const workflowRef = `${REPOSITORY}/${WORKFLOW}@${REF}`;
  if (env.GITHUB_WORKFLOW_REF !== workflowRef || !COMMIT.test(env.GITHUB_SHA || "")) fail("WORKFLOW_SCOPE_MISMATCH", env.GITHUB_WORKFLOW_REF || "missing");
  if (!Number.isSafeInteger(event.issue.number) || event.issue.number < 1 || event.issue.html_url !== `https://github.com/${REPOSITORY}/issues/${event.issue.number}`) fail("ISSUE_IDENTITY_INVALID", String(event.issue.number));
  const body = safeText(event.issue.body, "issue.body", 65000);
  let envelope;
  try { envelope = JSON.parse(body); } catch { fail("INVALID_ISSUE_JSON", "issue body"); }
  const validated = validatePublicationEnvelope(envelope);
  if (body.trim() !== canonicalJson(validated)) fail("NONCANONICAL_ISSUE_JSON", "issue body");
  const expectedTitle = `${TITLE_PREFIX} ${validated.observation.observer_id} — ${validated.observation.observation_id}`;
  if (event.issue.title !== expectedTitle) fail("ISSUE_TITLE_MISMATCH", expectedTitle);
  return { envelope: validated, published_at_utc: iso(event.issue.created_at, "issue.created_at"), issue_number: event.issue.number, issue_url: event.issue.html_url, workflow_ref: workflowRef, workflow_sha: env.GITHUB_SHA };
}

export async function publish({ root, envelope, context, attempts = 4, push = true, beforePush = null }) {
  if (beforePush !== null && typeof beforePush !== "function") fail("INVALID_PUBLISH_HOOK", "beforePush");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const head = await repositoryState(root);
    const prepared = await prepareAttempt(root, envelope, context, head);
    const receipt = validateMachineReceipt({ schema_version: MACHINE_RECEIPT_SCHEMA, accepted: true, idempotent: prepared.idempotent, issue_number: context.issue_number, workflow_run_id: process.env.GITHUB_RUN_ID || null, observer_id: envelope.observation.observer_id, observation_id: envelope.observation.observation_id, submission_nonce: envelope.submission_nonce, expected_head: envelope.expected_repository_head, publication_commit: prepared.commit, parent_commit: prepared.parent, attempt, retries: attempt - 1, permanent_url: `https://pulsechain-research-control-room.brohexphiat.chatgpt.site/research/external-observers/${envelope.observation.observer_id}/observations/${envelope.observation.observation_id}`, manifest_sha256: prepared.entry.manifest_sha256, error_code: null, rebase_required: false, generated_at_utc: new Date().toISOString() });
    if (prepared.idempotent || !push) return receipt;
    if (beforePush) await beforePush({ attempt, parent: prepared.parent, publication_commit: prepared.commit });
    const pushed = await git(root, ["push", "origin", "HEAD:main"], { allowFailure: true });
    if (pushed.code === 0) return receipt;
    await git(root, ["reset", "--hard", prepared.parent]);
  }
  fail("FAST_FORWARD_RETRIES_EXHAUSTED", envelope.observation.observation_id, true);
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  let receipt;
  let publicationError = null;
  try {
    const context = validateGitHubContext(event, process.env);
    receipt = await publish({ root: process.cwd(), envelope: context.envelope, context, attempts: 4, push: true });
  } catch (error) {
    publicationError = error;
    let parsed = null;
    try { parsed = JSON.parse(event?.issue?.body || ""); } catch { parsed = null; }
    const rawObserver = parsed?.observation?.observer_id;
    const rawObservation = parsed?.observation?.observation_id;
    const rawNonce = parsed?.submission_nonce;
    const rawHead = parsed?.expected_repository_head;
    const known = error instanceof ExternalObserverPublishError;
    receipt = validateMachineReceipt({
      schema_version: MACHINE_RECEIPT_SCHEMA,
      issue_number: event?.issue?.number,
      observer_id: OBSERVERS.includes(rawObserver) ? rawObserver : null,
      observation_id: OBSERVATION_ID.test(rawObservation || "") ? rawObservation : null,
      submission_nonce: NONCE.test(rawNonce || "") ? rawNonce : null,
      accepted: false,
      error_code: known ? error.code : "UNEXPECTED_FAILURE",
      expected_head: COMMIT.test(rawHead || "") ? rawHead : null,
      parent_commit: null,
      publication_commit: null,
      manifest_sha256: null,
      permanent_url: null,
      workflow_run_id: process.env.GITHUB_RUN_ID || null,
      attempt: 0,
      retries: 0,
      generated_at_utc: new Date().toISOString(),
      rebase_required: known ? error.rebase_required : false,
      idempotent: false,
    });
  }
  await postMachineReceiptComment({ issueNumber: event.issue.number, receipt, githubToken: process.env.GITHUB_TOKEN });
  process.stdout.write(`${canonicalJson(receipt)}\n`);
  if (publicationError) {
    process.stderr.write(`${publicationError instanceof ExternalObserverPublishError ? publicationError.message : "UNEXPECTED_FAILURE"}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof ExternalObserverPublishError ? error.message : "UNEXPECTED_FAILURE"}\n`);
    process.exitCode = 1;
  });
}

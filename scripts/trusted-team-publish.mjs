#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const PROJECT_ID = "pulsechain-investor-intelligence";
export const REPOSITORY = "opus99999/pulsechain-mcp";
export const REPOSITORY_ID = "1320639709";
export const OWNER_ID = "212180323";
export const AUTHORIZED_ACTOR = "opus99999";
export const AUTHORIZED_ACTOR_ID = "212180323";
export const REF = "refs/heads/main";
export const REQUEST_SCHEMA = "pulsechain-trusted-team-publication@1.0.0";
export const MANIFEST_SCHEMA = "pulsechain-trusted-team-update-manifest@1.0.0";
export const PROJECT_STATE_SCHEMA = "pulsechain-trusted-team-project-state@1.0.0";
export const LATEST_SCHEMA = "pulsechain-trusted-team-latest@1.0.0";
export const INDEX_SCHEMA = "pulsechain-trusted-team-index@1.0.0";
export const RECEIPT_SCHEMA = "pulsechain-trusted-team-publication-receipt@1.0.0";
export const MAX_ATTEMPTS = 4;
export const PUBLIC_ORIGIN = "https://pulsechain-research-control-room.brohexphiat.chatgpt.site";

export const WORKSTREAMS = Object.freeze([
  "signals-platform",
  "validator-flows",
  "identity-attribution",
  "investor-intelligence",
]);

const WORKSTREAM_SET = new Set(WORKSTREAMS);
const VISIBILITIES = new Set(["PUBLIC", "WORKSPACE", "PRIVATE"]);
const UPLOAD_STATUSES = new Set(["UPLOADED", "MANUAL_UPLOAD_PENDING"]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const UPDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const SAFE_CLASSIFICATION = /^[A-Z0-9][A-Z0-9_-]{1,127}$/;
const SECRET_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{20,})/i;
const REQUEST_FIELDS = new Set([
  "schema_version",
  "project_id",
  "workstream_id",
  "update_id",
  "expected_repository_head",
  "expected_latest_update_id",
  "title",
  "status",
  "classification",
  "current_task",
  "dependencies",
  "summary_markdown",
  "final_response_markdown",
  "project_state_summary",
  "next_work_handoff_markdown",
  "visibility",
  "artifact",
  "public_metadata_attestation",
]);
const ARTIFACT_FIELDS = new Set([
  "filename",
  "byte_size",
  "sha256",
  "member_count",
  "generated_at",
  "workstream_id",
  "update_id",
  "library_folder",
  "visibility",
  "upload_status",
]);
const ATTESTATION_FIELDS = new Set([
  "public_metadata_approved",
  "contains_secrets",
  "contains_hidden_reasoning",
  "contains_private_contact_information",
  "contains_raw_restricted_material",
  "synthetic_canary",
]);
const LATEST_FIELDS = new Set([
  "schema_version", "project_id", "workstream_id", "update_id", "update_path", "published_at",
  "classification", "status", "current_task", "manifest_sha256", "artifact",
]);
const INDEX_FIELDS = new Set(["schema_version", "project_id", "workstream_id", "updates"]);
const INDEX_ENTRY_FIELDS = new Set([
  "update_id", "update_path", "published_at", "classification", "status", "manifest_sha256",
  "artifact_filename", "artifact_sha256",
]);

function fail(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  throw error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) fail("INVALID_OBJECT", `${label} must be an object`);
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !expected.has(key));
  const missing = [...expected].filter((key) => !(key in value));
  if (unknown.length) fail("UNKNOWN_FIELD", `${label}.${unknown[0]}`);
  if (missing.length) fail("MISSING_FIELD", `${label}.${missing[0]}`);
}

function safeText(value, label, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    fail("INVALID_TEXT", label);
  }
  if (!allowEmpty && !value.trim()) fail("EMPTY_TEXT", label);
  if (SECRET_PATTERN.test(value)) fail("PUBLIC_METADATA_SECRET_PATTERN", label);
  return value;
}

function safeIdentifier(value, label, maximum = 300) {
  const text = safeText(value, label, maximum);
  if (/[\u0000-\u001f\u007f]/.test(text)) fail("INVALID_CONTROL_CHARACTER", label);
  return text;
}

function safeInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_INTEGER", label);
  }
  return value;
}

function isoTime(value, label) {
  const text = safeIdentifier(value, label, 80);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== text) fail("INVALID_TIME", label);
  return text;
}

function safeFilename(value, label) {
  const text = safeIdentifier(value, label, 180);
  if (
    !text.endsWith(".zip") ||
    text.startsWith(".") ||
    text.includes("/") ||
    text.includes("\\") ||
    text === "." ||
    text === ".." ||
    /%2f|%5c|%00/i.test(text) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/.test(text)
  ) {
    fail("INVALID_ZIP_FILENAME", label);
  }
  return text;
}

function validateJsonValue(value, label, depth = 0, state = { nodes: 0 }) {
  state.nodes += 1;
  if (state.nodes > 10_000 || depth > 20) fail("JSON_COMPLEXITY_LIMIT", label);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    safeText(value, label, 100_000, { allowEmpty: true });
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("UNSAFE_JSON_NUMBER", label);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonValue(item, `${label}[${index}]`, depth + 1, state));
    return;
  }
  if (plainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) fail("UNSAFE_JSON_KEY", `${label}.${key}`);
      safeIdentifier(key, `${label} key`, 160);
      validateJsonValue(item, `${label}.${key}`, depth + 1, state);
    }
    return;
  }
  fail("UNSUPPORTED_JSON_VALUE", label);
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("NONCANONICAL_JSON_VALUE", "value cannot be serialized");
}

export function jsonBytes(value) {
  validateJsonValue(value, "document");
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function emptyLatest(workstream) {
  if (!WORKSTREAM_SET.has(workstream)) fail("INVALID_WORKSTREAM", workstream);
  return {
    schema_version: LATEST_SCHEMA,
    project_id: PROJECT_ID,
    workstream_id: workstream,
    update_id: null,
    update_path: null,
    published_at: null,
    classification: null,
    status: "EMPTY",
    current_task: null,
    manifest_sha256: null,
    artifact: null,
  };
}

export function emptyIndex(workstream) {
  if (!WORKSTREAM_SET.has(workstream)) fail("INVALID_WORKSTREAM", workstream);
  return {
    schema_version: INDEX_SCHEMA,
    project_id: PROJECT_ID,
    workstream_id: workstream,
    updates: [],
  };
}

function validateDependencies(value) {
  if (!Array.isArray(value) || value.length > 100) fail("INVALID_DEPENDENCIES", "dependencies");
  const result = value.map((item, index) => safeText(item, `dependencies[${index}]`, 500));
  if (new Set(result).size !== result.length) fail("DUPLICATE_DEPENDENCY", "dependencies");
  return result;
}

function validateArtifact(value, workstream, updateId, visibility) {
  exactKeys(value, ARTIFACT_FIELDS, "artifact");
  const filename = safeFilename(value.filename, "artifact.filename");
  const byteSize = safeInteger(value.byte_size, "artifact.byte_size", 1, 2_147_483_647);
  if (!SHA256.test(value.sha256)) fail("INVALID_SHA256", "artifact.sha256");
  const memberCount = safeInteger(value.member_count, "artifact.member_count", 1, 100_000);
  const generatedAt = isoTime(value.generated_at, "artifact.generated_at");
  if (value.workstream_id !== workstream) fail("ARTIFACT_WORKSTREAM_MISMATCH", "artifact.workstream_id");
  if (value.update_id !== updateId) fail("ARTIFACT_UPDATE_MISMATCH", "artifact.update_id");
  const libraryFolder = `PulseChain_Control_Room/${workstream}/`;
  if (value.library_folder !== libraryFolder) fail("LIBRARY_FOLDER_MISMATCH", "artifact.library_folder");
  if (value.visibility !== visibility || !VISIBILITIES.has(value.visibility)) {
    fail("ARTIFACT_VISIBILITY_MISMATCH", "artifact.visibility");
  }
  if (!UPLOAD_STATUSES.has(value.upload_status)) fail("INVALID_ARTIFACT_UPLOAD_STATUS", "artifact.upload_status");
  return {
    filename,
    byte_size: byteSize,
    sha256: value.sha256,
    member_count: memberCount,
    generated_at: generatedAt,
    workstream_id: workstream,
    update_id: updateId,
    library_folder: libraryFolder,
    visibility,
    upload_status: value.upload_status,
  };
}

function validateAttestation(value) {
  exactKeys(value, ATTESTATION_FIELDS, "public_metadata_attestation");
  if (
    value.public_metadata_approved !== true ||
    value.contains_secrets !== false ||
    value.contains_hidden_reasoning !== false ||
    value.contains_private_contact_information !== false ||
    value.contains_raw_restricted_material !== false ||
    typeof value.synthetic_canary !== "boolean"
  ) {
    fail("PUBLIC_METADATA_ATTESTATION_FAILED", "publication metadata is not approved for public projection");
  }
  return { ...value };
}

export function validatePublicationRequest(value, fixedWorkstream) {
  if (!WORKSTREAM_SET.has(fixedWorkstream)) fail("INVALID_FIXED_WORKSTREAM", fixedWorkstream);
  exactKeys(value, REQUEST_FIELDS, "request");
  if (value.schema_version !== REQUEST_SCHEMA) fail("REQUEST_SCHEMA_MISMATCH", "schema_version");
  if (value.project_id !== PROJECT_ID) fail("PROJECT_SCOPE_MISMATCH", "project_id");
  if (value.workstream_id !== fixedWorkstream) fail("WORKSTREAM_SCOPE_MISMATCH", "workstream_id");
  if (!UPDATE_ID.test(value.update_id)) fail("INVALID_UPDATE_ID", "update_id");
  if (!COMMIT.test(value.expected_repository_head)) fail("INVALID_EXPECTED_HEAD", "expected_repository_head");
  if (value.expected_latest_update_id !== null && !UPDATE_ID.test(value.expected_latest_update_id)) {
    fail("INVALID_EXPECTED_LATEST", "expected_latest_update_id");
  }
  const title = safeText(value.title, "title", 300);
  const status = safeIdentifier(value.status, "status", 80);
  const classification = safeIdentifier(value.classification, "classification", 128);
  if (!SAFE_CLASSIFICATION.test(classification)) fail("INVALID_CLASSIFICATION", "classification");
  const currentTask = safeText(value.current_task, "current_task", 1000);
  const dependencies = validateDependencies(value.dependencies);
  const summary = safeText(value.summary_markdown, "summary_markdown", 300_000);
  const finalResponse = safeText(value.final_response_markdown, "final_response_markdown", 1_000_000);
  const projectStateSummary = safeText(value.project_state_summary, "project_state_summary", 300_000);
  const handoff = safeText(value.next_work_handoff_markdown, "next_work_handoff_markdown", 300_000);
  if (!VISIBILITIES.has(value.visibility)) fail("INVALID_VISIBILITY", "visibility");
  const artifact = validateArtifact(value.artifact, fixedWorkstream, value.update_id, value.visibility);
  const attestation = validateAttestation(value.public_metadata_attestation);
  return {
    schema_version: REQUEST_SCHEMA,
    project_id: PROJECT_ID,
    workstream_id: fixedWorkstream,
    update_id: value.update_id,
    expected_repository_head: value.expected_repository_head,
    expected_latest_update_id: value.expected_latest_update_id,
    title,
    status,
    classification,
    current_task: currentTask,
    dependencies,
    summary_markdown: summary,
    final_response_markdown: finalResponse,
    project_state_summary: projectStateSummary,
    next_work_handoff_markdown: handoff,
    visibility: value.visibility,
    artifact,
    public_metadata_attestation: attestation,
  };
}

function workflowPath(workstream) {
  return `.github/workflows/trusted-team-${workstream}.yml`;
}

export function validateGitHubContext(event, env, fixedWorkstream) {
  if (!plainObject(event) || !plainObject(event.issue) || !plainObject(event.repository) || !plainObject(event.sender)) {
    fail("INVALID_GITHUB_EVENT", "issue event is incomplete");
  }
  if (
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    String(env.GITHUB_REPOSITORY_ID) !== REPOSITORY_ID ||
    String(env.GITHUB_REPOSITORY_OWNER_ID) !== OWNER_ID ||
    env.GITHUB_REF !== REF ||
    env.GITHUB_EVENT_NAME !== "issues" ||
    env.GITHUB_EVENT_ACTION !== "opened" ||
    String(env.GITHUB_ACTOR_ID) !== AUTHORIZED_ACTOR_ID ||
    env.GITHUB_ACTOR !== AUTHORIZED_ACTOR ||
    event.action !== "opened" ||
    event.repository.full_name !== REPOSITORY ||
    String(event.repository.id) !== REPOSITORY_ID ||
    String(event.repository.owner?.id) !== OWNER_ID ||
    String(event.sender.id) !== AUTHORIZED_ACTOR_ID ||
    event.sender.login !== AUTHORIZED_ACTOR ||
    String(event.issue.user?.id) !== AUTHORIZED_ACTOR_ID ||
    event.issue.user?.login !== AUTHORIZED_ACTOR
  ) {
    fail("GITHUB_IDENTITY_MISMATCH", "repository, owner, actor, ref, or event is outside the fixed scope");
  }
  const expectedWorkflowRef = `${REPOSITORY}/${workflowPath(fixedWorkstream)}@${REF}`;
  if (env.GITHUB_WORKFLOW_REF !== expectedWorkflowRef) fail("WORKFLOW_SCOPE_MISMATCH", env.GITHUB_WORKFLOW_REF || "missing");
  if (!COMMIT.test(env.GITHUB_SHA || "")) fail("INVALID_WORKFLOW_COMMIT", "GITHUB_SHA");
  if (env.GITHUB_WORKFLOW_SHA && env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA) {
    fail("WORKFLOW_COMMIT_MISMATCH", "GITHUB_WORKFLOW_SHA");
  }
  if (!Number.isSafeInteger(event.issue.number) || event.issue.number < 1) fail("INVALID_ISSUE_NUMBER", "issue.number");
  const createdAt = isoTime(event.issue.created_at, "issue.created_at");
  const expectedIssueUrl = `https://github.com/${REPOSITORY}/issues/${event.issue.number}`;
  if (event.issue.html_url !== expectedIssueUrl) fail("ISSUE_URL_MISMATCH", "issue.html_url");
  const body = safeText(event.issue.body, "issue.body", 65_000);
  let request;
  try {
    request = JSON.parse(body);
  } catch {
    fail("INVALID_ISSUE_JSON", "issue body must be one JSON object without a Markdown fence");
  }
  const validated = validatePublicationRequest(request, fixedWorkstream);
  const exactTitle = `[TRUSTED_TEAM ${fixedWorkstream}] PUBLISH ${validated.update_id}`;
  if (event.issue.title !== exactTitle) fail("ISSUE_TITLE_MISMATCH", `expected ${exactTitle}`);
  return {
    request: validated,
    published_at: createdAt,
    issue_number: event.issue.number,
    issue_url: safeText(event.issue.html_url, "issue.html_url", 500),
    workflow_ref: expectedWorkflowRef,
    workflow_sha: env.GITHUB_SHA,
    actor: AUTHORIZED_ACTOR,
    actor_id: AUTHORIZED_ACTOR_ID,
  };
}

export function renderUpdate(request, context) {
  const updatePath = `workstreams/${request.workstream_id}/updates/${request.update_id}`;
  const summaryBytes = Buffer.from(
    `# ${request.title}\n\n## Approved summary\n\n${request.summary_markdown.trim()}\n\n## Complete final response\n\n${request.final_response_markdown.trim()}\n`,
    "utf8",
  );
  const projectState = {
    schema_version: PROJECT_STATE_SCHEMA,
    project_id: PROJECT_ID,
    workstream_id: request.workstream_id,
    update_id: request.update_id,
    status: request.status,
    current_task: request.current_task,
    dependencies: request.dependencies,
    state_summary: request.project_state_summary,
  };
  const projectStateBytes = jsonBytes(projectState);
  const handoffBytes = Buffer.from(`${request.next_work_handoff_markdown.trim()}\n`, "utf8");
  const governedFiles = [
    { filename: "summary.md", bytes: summaryBytes },
    { filename: "project_state.json", bytes: projectStateBytes },
    { filename: "next_work_handoff.md", bytes: handoffBytes },
  ];
  const manifest = {
    schema_version: MANIFEST_SCHEMA,
    project_id: PROJECT_ID,
    workstream_id: request.workstream_id,
    update_id: request.update_id,
    status: request.status,
    classification: request.classification,
    published_at: context.published_at,
    current_task: request.current_task,
    dependencies: request.dependencies,
    visibility: request.visibility,
    files: governedFiles.map(({ filename, bytes }) => ({
      filename,
      byte_size: bytes.byteLength,
      sha256: sha256(bytes),
    })),
    artifact: request.artifact,
    publication: {
      source_issue_number: context.issue_number,
      source_issue_url: context.issue_url,
      actor: context.actor,
      actor_id: context.actor_id,
      workflow_ref: context.workflow_ref,
      workflow_sha: context.workflow_sha,
      public_metadata_attestation: request.public_metadata_attestation,
    },
  };
  const manifestBytes = jsonBytes(manifest);
  const manifestHash = sha256(manifestBytes);
  return {
    updatePath,
    files: new Map([
      ...governedFiles.map(({ filename, bytes }) => [`${updatePath}/${filename}`, bytes]),
      [`${updatePath}/manifest.json`, manifestBytes],
    ]),
    manifest,
    manifestHash,
    latest: {
      schema_version: LATEST_SCHEMA,
      project_id: PROJECT_ID,
      workstream_id: request.workstream_id,
      update_id: request.update_id,
      update_path: updatePath,
      published_at: context.published_at,
      classification: request.classification,
      status: request.status,
      current_task: request.current_task,
      manifest_sha256: manifestHash,
      artifact: {
        filename: request.artifact.filename,
        sha256: request.artifact.sha256,
      },
    },
    indexEntry: {
      update_id: request.update_id,
      update_path: updatePath,
      published_at: context.published_at,
      classification: request.classification,
      status: request.status,
      manifest_sha256: manifestHash,
      artifact_filename: request.artifact.filename,
      artifact_sha256: request.artifact.sha256,
    },
  };
}

function validateLatest(value, workstream) {
  exactKeys(value, LATEST_FIELDS, "latest");
  if (!plainObject(value) || value.schema_version !== LATEST_SCHEMA || value.project_id !== PROJECT_ID || value.workstream_id !== workstream) {
    fail("CORRUPT_LATEST_POINTER", workstream);
  }
  if (value.update_id !== null && !UPDATE_ID.test(value.update_id)) fail("CORRUPT_LATEST_POINTER", "update_id");
  if (value.update_id === null) {
    if (
      value.update_path !== null || value.published_at !== null || value.classification !== null ||
      value.current_task !== null || value.manifest_sha256 !== null || value.artifact !== null || value.status !== "EMPTY"
    ) fail("CORRUPT_LATEST_POINTER", "empty pointer fields");
  } else {
    if (value.update_path !== `workstreams/${workstream}/updates/${value.update_id}` || !SHA256.test(value.manifest_sha256 || "")) {
      fail("CORRUPT_LATEST_POINTER", "accepted pointer identity");
    }
    isoTime(value.published_at, "latest.published_at");
    safeIdentifier(value.classification, "latest.classification", 128);
    safeIdentifier(value.status, "latest.status", 80);
    safeText(value.current_task, "latest.current_task", 1000);
    exactKeys(value.artifact, new Set(["filename", "sha256"]), "latest.artifact");
    safeFilename(value.artifact.filename, "latest.artifact.filename");
    if (!SHA256.test(value.artifact.sha256)) fail("CORRUPT_LATEST_POINTER", "artifact sha256");
  }
  return value;
}

function validateIndex(value, workstream) {
  exactKeys(value, INDEX_FIELDS, "index");
  if (!plainObject(value) || value.schema_version !== INDEX_SCHEMA || value.project_id !== PROJECT_ID || value.workstream_id !== workstream || !Array.isArray(value.updates)) {
    fail("CORRUPT_WORKSTREAM_INDEX", workstream);
  }
  if (value.updates.length > 100_000) fail("WORKSTREAM_INDEX_LIMIT", workstream);
  const seen = new Set();
  let previousPublishedAt = Number.POSITIVE_INFINITY;
  for (const entry of value.updates) {
    exactKeys(entry, INDEX_ENTRY_FIELDS, "index entry");
    if (!plainObject(entry) || !UPDATE_ID.test(entry.update_id || "") || seen.has(entry.update_id)) {
      fail("CORRUPT_WORKSTREAM_INDEX", "duplicate or invalid update identity");
    }
    if (
      entry.update_path !== `workstreams/${workstream}/updates/${entry.update_id}` ||
      !SHA256.test(entry.manifest_sha256 || "") || !SHA256.test(entry.artifact_sha256 || "")
    ) fail("CORRUPT_WORKSTREAM_INDEX", "entry identity");
    isoTime(entry.published_at, "index entry published_at");
    const publishedAt = Date.parse(entry.published_at);
    if (publishedAt > previousPublishedAt) fail("CORRUPT_WORKSTREAM_INDEX", "updates are not newest-first");
    previousPublishedAt = publishedAt;
    safeIdentifier(entry.classification, "index entry classification", 128);
    safeIdentifier(entry.status, "index entry status", 80);
    safeFilename(entry.artifact_filename, "index entry artifact_filename");
    seen.add(entry.update_id);
  }
  return value;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0 || options.allowFailure) resolvePromise(result);
      else rejectPromise(Object.assign(new Error(stderr.trim() || `${command} exited ${code}`), { result }));
    });
  });
}

async function git(root, args, options = {}) {
  return run("git", args, { cwd: root, ...options });
}

async function readJson(path, label) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("INVALID_LEDGER_JSON", label);
  }
  validateJsonValue(value, label);
  return value;
}

async function writeBytes(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: "wx" });
}

async function changedPaths(root, from, to, prefix = null) {
  const args = ["diff", "--name-only", "--no-renames", `${from}..${to}`, "--"];
  if (prefix) args.push(prefix);
  const result = await git(root, args);
  return result.stdout ? result.stdout.split("\n").filter(Boolean) : [];
}

async function pathExistsAt(root, commit, path) {
  const result = await git(root, ["cat-file", "-e", `${commit}:${path}`], { allowFailure: true });
  return result.code === 0;
}

async function verifyExpectedBase(root, request, base) {
  const ancestor = await git(root, ["merge-base", "--is-ancestor", request.expected_repository_head, base], { allowFailure: true });
  if (ancestor.code !== 0) fail("EXPECTED_HEAD_NOT_ANCESTOR", request.expected_repository_head);
  if (base !== request.expected_repository_head) {
    const changes = await changedPaths(root, request.expected_repository_head, base);
    const ownPrefix = `workstreams/${request.workstream_id}/`;
    const ownChange = changes.find((path) => path.startsWith(ownPrefix));
    if (ownChange) fail("WORKSTREAM_HEAD_ADVANCED", ownChange);
    const allowedOtherLedgerPath = (path) => {
      const match = path.match(/^workstreams\/([^/]+)\/(latest\.json|index\.json|updates\/([A-Za-z0-9][A-Za-z0-9._-]{7,127})\/(summary\.md|project_state\.json|next_work_handoff\.md|manifest\.json))$/);
      return Boolean(match && WORKSTREAM_SET.has(match[1]) && match[1] !== request.workstream_id);
    };
    const controlDrift = changes.find((path) => !allowedOtherLedgerPath(path));
    if (controlDrift) fail("EXPECTED_HEAD_CONTROL_DRIFT", controlDrift);
  }
}

async function fetchMain(root) {
  await git(root, ["fetch", "--no-tags", "origin", "main"]);
  const head = await git(root, ["rev-parse", "refs/remotes/origin/main"]);
  if (!COMMIT.test(head.stdout)) fail("INVALID_REMOTE_HEAD", head.stdout);
  return head.stdout;
}

async function prepareAttempt(root, request, context, base) {
  await git(root, ["reset", "--hard", base]);
  const prefix = `workstreams/${request.workstream_id}`;
  const latestPath = `${prefix}/latest.json`;
  const indexPath = `${prefix}/index.json`;
  const latest = validateLatest(await readJson(resolve(root, latestPath), latestPath), request.workstream_id);
  const index = validateIndex(await readJson(resolve(root, indexPath), indexPath), request.workstream_id);
  const indexedLatest = index.updates.length ? index.updates[0].update_id : null;
  if (indexedLatest !== latest.update_id) fail("LATEST_INDEX_DIVERGENCE", request.workstream_id);
  if (latest.update_id !== request.expected_latest_update_id) {
    fail("WORKSTREAM_HEAD_ADVANCED", `expected ${request.expected_latest_update_id ?? "null"}, found ${latest.update_id ?? "null"}`);
  }
  if (index.updates.some((entry) => entry.update_id === request.update_id)) fail("UPDATE_ID_ALREADY_EXISTS", request.update_id);
  const rendered = renderUpdate(request, context);
  if (await pathExistsAt(root, base, rendered.updatePath)) fail("UPDATE_PATH_ALREADY_EXISTS", rendered.updatePath);
  for (const [path, bytes] of rendered.files) await writeBytes(resolve(root, path), bytes);
  await writeFile(resolve(root, latestPath), jsonBytes(rendered.latest));
  if (index.updates.length && Date.parse(rendered.indexEntry.published_at) < Date.parse(index.updates[0].published_at)) {
    fail("PUBLICATION_TIME_PRECEDES_LATEST", rendered.indexEntry.published_at);
  }
  await writeFile(resolve(root, indexPath), jsonBytes({ ...index, updates: [rendered.indexEntry, ...index.updates] }));
  const expectedPaths = [...rendered.files.keys(), latestPath, indexPath].sort();
  await git(root, ["add", "--", ...expectedPaths]);
  const staged = await git(root, ["diff", "--cached", "--name-only", "--"]);
  const stagedPaths = staged.stdout ? staged.stdout.split("\n").filter(Boolean).sort() : [];
  if (canonicalJson(stagedPaths) !== canonicalJson(expectedPaths)) fail("UNEXPECTED_LEDGER_DIFF", stagedPaths.join(","));
  const commit = await git(root, [
    "-c", "user.name=PulseChain Trusted-Team Publisher",
    "-c", "user.email=trusted-team-publisher@users.noreply.github.com",
    "commit", "-m", `Publish ${request.workstream_id} update ${request.update_id}`, "--", prefix,
  ]);
  void commit;
  const commitSha = (await git(root, ["rev-parse", "HEAD"])).stdout;
  const parent = (await git(root, ["rev-parse", "HEAD^"])).stdout;
  if (parent !== base) fail("COMMIT_PARENT_MISMATCH", `${parent} != ${base}`);
  const committedPathsResult = await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", commitSha, "--"]);
  const committedPaths = committedPathsResult.stdout ? committedPathsResult.stdout.split("\n").filter(Boolean).sort() : [];
  if (canonicalJson(committedPaths) !== canonicalJson(expectedPaths)) fail("UNEXPECTED_COMMIT_PATH", committedPaths.join(","));
  return { rendered, commitSha, base, paths: expectedPaths };
}

async function verifyAcceptedCommit(root, prepared, request) {
  const remoteHead = await fetchMain(root);
  const ancestor = await git(root, ["merge-base", "--is-ancestor", prepared.commitSha, remoteHead], { allowFailure: true });
  if (ancestor.code !== 0) fail("PUBLISHED_COMMIT_NOT_REACHABLE", prepared.commitSha);
  for (const [path, expected] of prepared.rendered.files) {
    const blob = (await git(root, ["rev-parse", `${prepared.commitSha}:${path}`])).stdout;
    const expectedBlob = createHash("sha1")
      .update(Buffer.from(`blob ${expected.byteLength}\0`, "utf8"))
      .update(expected)
      .digest("hex");
    if (blob !== expectedBlob) fail("PUBLISHED_BLOB_MISMATCH", path);
  }
  const latest = JSON.parse((await git(root, ["show", `${prepared.commitSha}:workstreams/${request.workstream_id}/latest.json`])).stdout);
  if (latest.update_id !== request.update_id || latest.manifest_sha256 !== prepared.rendered.manifestHash) {
    fail("PUBLISHED_READBACK_MISMATCH", request.update_id);
  }
  const index = JSON.parse((await git(root, ["show", `${prepared.commitSha}:workstreams/${request.workstream_id}/index.json`])).stdout);
  const matching = index.updates.filter((entry) => entry.update_id === request.update_id);
  if (matching.length !== 1 || matching[0].manifest_sha256 !== prepared.rendered.manifestHash) {
    fail("PUBLISHED_INDEX_READBACK_MISMATCH", request.update_id);
  }
  return remoteHead;
}

// The optional hook exists only to make the first-push concurrency point deterministic in the local test harness.
export async function publishToLedger({ repositoryRoot, request, context, hooks = {}, maxAttempts = MAX_ATTEMPTS }) {
  const root = resolve(repositoryRoot);
  if (maxAttempts !== MAX_ATTEMPTS) fail("INVALID_RETRY_BUDGET", `must equal ${MAX_ATTEMPTS}`);
  const clean = await git(root, ["status", "--porcelain"]);
  if (clean.stdout) fail("DIRTY_PUBLISHER_CHECKOUT", clean.stdout.split("\n")[0]);
  let lastPushError = null;
  let firstObservedRepositoryHead = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const observedBeforeAttempt = await fetchMain(root);
    if (firstObservedRepositoryHead === null) firstObservedRepositoryHead = observedBeforeAttempt;
    await verifyExpectedBase(root, request, observedBeforeAttempt);
    // The first commit deliberately uses the caller's optimistic head. This makes a
    // cross-workstream head advance observable as one non-fast-forward and proves
    // the bounded retry path instead of silently starting from a newer checkout.
    const base = attempt === 1 ? request.expected_repository_head : observedBeforeAttempt;
    const prepared = await prepareAttempt(root, request, context, base);
    if (hooks.beforePush) await hooks.beforePush({ attempt, base, commit: prepared.commitSha, workstream: request.workstream_id });
    const pushed = await git(root, ["push", "origin", `HEAD:${REF}`], { allowFailure: true });
    if (pushed.code === 0) {
      const observedHead = await verifyAcceptedCommit(root, prepared, request);
      return {
        schema_version: RECEIPT_SCHEMA,
        result: "ACCEPTED",
        repository: REPOSITORY,
        workstream_id: request.workstream_id,
        update_id: request.update_id,
        update_path: prepared.rendered.updatePath,
        permanent_update_url: `${PUBLIC_ORIGIN}/research/workstreams/${request.workstream_id}/updates/${request.update_id}`,
        commit: prepared.commitSha,
        parent_commit: prepared.base,
        initial_repository_head: request.expected_repository_head,
        first_observed_repository_head: firstObservedRepositoryHead,
        observed_repository_head: observedHead,
        manifest_sha256: prepared.rendered.manifestHash,
        artifact_filename: request.artifact.filename,
        artifact_sha256: request.artifact.sha256,
        attempts: attempt,
        retries: attempt - 1,
        issue_number: context.issue_number,
      };
    }
    lastPushError = pushed.stderr || pushed.stdout || "push rejected";
    const afterFailure = await fetchMain(root);
    const accepted = await git(root, ["merge-base", "--is-ancestor", prepared.commitSha, afterFailure], { allowFailure: true });
    if (accepted.code === 0) {
      return {
        schema_version: RECEIPT_SCHEMA,
        result: "ACCEPTED",
        repository: REPOSITORY,
        workstream_id: request.workstream_id,
        update_id: request.update_id,
        update_path: prepared.rendered.updatePath,
        permanent_update_url: `${PUBLIC_ORIGIN}/research/workstreams/${request.workstream_id}/updates/${request.update_id}`,
        commit: prepared.commitSha,
        parent_commit: prepared.base,
        initial_repository_head: request.expected_repository_head,
        first_observed_repository_head: firstObservedRepositoryHead,
        observed_repository_head: afterFailure,
        manifest_sha256: prepared.rendered.manifestHash,
        artifact_filename: request.artifact.filename,
        artifact_sha256: request.artifact.sha256,
        attempts: attempt,
        retries: attempt - 1,
        issue_number: context.issue_number,
      };
    }
    if (afterFailure === base) fail("PUSH_FAILED_WITHOUT_HEAD_ADVANCE", lastPushError.slice(0, 500));
    await verifyExpectedBase(root, request, afterFailure);
  }
  fail("PUBLICATION_RETRY_EXHAUSTED", String(lastPushError || "non-fast-forward").slice(0, 500));
}

async function postReceipt(issueNumber, receipt, token = process.env.GITHUB_TOKEN) {
  if (!token) fail("MISSING_GITHUB_TOKEN", "receipt comment cannot be posted");
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ body: `\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\`` }),
  });
  if (!response.ok) fail("RECEIPT_COMMENT_FAILED", `${response.status}`);
}

async function main() {
  const fixedWorkstream = process.argv[2];
  if (!WORKSTREAM_SET.has(fixedWorkstream) || process.argv.length !== 3) fail("INVALID_WORKSTREAM_ARGUMENT", fixedWorkstream || "missing");
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const context = validateGitHubContext(event, process.env, fixedWorkstream);
  const receipt = await publishToLedger({
    repositoryRoot: process.env.GITHUB_WORKSPACE,
    request: context.request,
    context,
  });
  let receiptComment = "POSTED";
  try {
    await postReceipt(context.issue_number, receipt);
  } catch (error) {
    // The immutable update is already accepted. A comment transport failure must not trigger a duplicate publication.
    receiptComment = `FAILED:${String(error.code || "RECEIPT_COMMENT_FAILED")}`;
  }
  process.stdout.write(`${JSON.stringify({ ...receipt, receipt_comment: receiptComment })}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ result: "REJECTED", code: error.code || "PUBLICATION_FAILED", detail: String(error.message || error).slice(0, 1000) })}\n`);
    process.exitCode = 1;
  });
}

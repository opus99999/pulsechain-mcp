#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "opus99999/pulsechain-mcp";
export const REPOSITORY_ID = "1320639709";
export const REPOSITORY_OWNER = "opus99999";
export const REPOSITORY_OWNER_ID = "212180323";
export const AUTHORIZED_ACTOR = "opus99999";
export const AUTHORIZED_ACTOR_ID = "212180323";
export const REF = "refs/heads/main";
export const WORKFLOW_PATH = ".github/workflows/head-chef-coordination-ingest.yml";
export const EVENT_SCHEMA = "pulsechain-head-chef-event@1.0.0";
export const RECEIPT_SCHEMA = "pulsechain-head-chef-event-receipt@1.0.0";
export const REJECTION_SCHEMA = "pulsechain-head-chef-event-rejection@1.0.0";
export const CONTROL_ROOM_ORIGIN = "https://pulsechain-research-control-room.brohexphiat.chatgpt.site";
export const ENDPOINT = `${CONTROL_ROOM_ORIGIN}/api/v1/head-chef/events/github`;

export const RECEIPT_MARKER = `<!-- ${RECEIPT_SCHEMA} -->`;

const TITLE_PREFIX = "[HEAD_CHEF QUESTION] ";
// Keep the governed body below 32 KiB while reserving storage headroom for
// server-derived receipt/provenance fields.
const MAX_BODY_BYTES = 30 * 1024;
const MAX_GITHUB_RESPONSE_BYTES = 256 * 1024;
const MAX_CONTROL_ROOM_RESPONSE_BYTES = 64 * 1024;
const TRANSITION_RETRY_DELAYS_MS = Object.freeze([
  2_000,
  4_000,
  8_000,
  16_000,
  30_000,
  45_000,
  60_000,
  60_000,
]);
// Projection preflight has its own smaller retry budget so the workflow still
// has time to obtain OIDC, submit the event, and reconcile an accepted receipt
// inside the seven-minute job timeout.
const PROJECTION_RETRY_DELAYS_MS = Object.freeze([
  2_000,
  4_000,
  8_000,
  16_000,
  30_000,
  45_000,
]);
const REQUEST_TIMEOUT_MS = 20_000;
const TRANSITION_RETRY_CODES = new Set([
  "CONTROL_ROOM_HEAD_CHEF_UNEXPECTED_TRANSITION",
  "CONTROL_ROOM_HEAD_CHEF_WRONG_ASSIGNMENT",
  "CONTROL_ROOM_HEAD_CHEF_CLOSURE_NOT_READY",
  "CONTROL_ROOM_HEAD_CHEF_CONDITION4_PUBLICATION_RECEIPT_MISMATCH",
]);
const PROJECTION_STATES = new Set([
  "HEAD_CHEF_REVIEW",
  "SPECIALIST_REVIEW",
  "OWNER_GATE_REQUIRED",
  "READY_FOR_CLOSURE",
  "READY_FOR_DELIVERY",
  "DELIVERED",
]);
const TERMINAL_ASSIGNMENT_STATES = new Set([
  "PUBLICATION_ACCEPTED",
  "VALIDATED_NO_CHANGE",
  "EVIDENCE_BLOCKED",
]);
const ASSIGNMENT_STATES = new Set([
  "PENDING_ACKNOWLEDGMENT",
  "ACKNOWLEDGED",
  "RESULT_POSTED",
  ...TERMINAL_ASSIGNMENT_STATES,
]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const QUESTION_ID = /^pulsechain-question-\d{17}-[a-f0-9]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,195}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,195}$/;
const ISSUE_NODE_ID = /^I_[A-Za-z0-9_-]{8,180}$/;
const COMMENT_NODE_ID = /^IC_[A-Za-z0-9_-]{8,180}$/;
const SAFE_CLASSIFICATION = /^[A-Z0-9][A-Z0-9_-]{1,127}$/;
const GITHUB_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const BOT_LOGIN = "github-actions[bot]";
const BOT_ID = "41898282";
const CONDITION4_COORDINATION_ID =
  "head-chef-condition-4-signals-investor-import-20260903";
const CONDITION4_SOURCE_RECORD_ID =
  "signals-platform-phiat-plsx-pass-through-review-20260902t204412z";
const CONDITION4_PRIOR_INVESTOR_UPDATE_ID =
  "investor-intelligence-plsx-drawdown-dependency-rebase-20260901t235405z";
const CONDITION4_DECISION_CLASS = "ACCEPTED_DEPENDENCY_IMPORT_REVIEW";
const CONDITION4_REQUESTED_DECISION =
  "Assess exact 843,579,441.647005259136001133 PLSX pass-through from source/helper 0x60719573BEAa21421a92D86657866121c8b21892 to target 0x8f56AA97ebef8080144FB21224E46a5D85657C23 and destination 0xB00d08E09FA48c2E1D48ac3EdE2fFea354341215; full downstream PulseX swap; 7,847.337744 USDC token units; HomeOmnibridge initiation; 1.084314 USDC bounded commingling; separation from the accepted phPLSX reserve drawdown; exact double-count amount of zero; no proven lending position; no proven public-exchange deposit; no change to accepted Identity or Atropa conclusions. Return only MATERIAL_IMPORT_PUBLICATION_REQUIRED, VALIDATED_NO_CHANGE_NO_PUBLICATION_REQUIRED, or BLOCKED_MISSING_ACCEPTED_EVIDENCE.";
const CONDITION4_TERMINAL_DECISIONS = new Set([
  "MATERIAL_IMPORT_PUBLICATION_REQUIRED",
  "VALIDATED_NO_CHANGE_NO_PUBLICATION_REQUIRED",
  "BLOCKED_MISSING_ACCEPTED_EVIDENCE",
]);
const CONDITION4_RESEARCH_EVENT_TYPES = new Set([
  "SPECIALIST_RESULT_POSTED",
  "SPECIALIST_PUBLICATION_REQUESTED",
  "SPECIALIST_NO_CHANGE_ACCEPTED",
  "SPECIALIST_EVIDENCE_BLOCKED",
]);
export const CONDITION4_RATIONALE_TOKENS = Object.freeze([
  "843,579,441.647005259136001133 PLSX pass-through",
  "source/helper 0x60719573BEAa21421a92D86657866121c8b21892",
  "target 0x8f56AA97ebef8080144FB21224E46a5D85657C23",
  "destination 0xB00d08E09FA48c2E1D48ac3EdE2fFea354341215",
  "full downstream PulseX swap",
  "7,847.337744 USDC token units",
  "HomeOmnibridge initiation",
  "1.084314 USDC bounded commingling",
  "separation from the accepted phPLSX reserve drawdown",
  "exact double-count amount of zero",
  "no proven lending position",
  "no proven public-exchange deposit",
  "no change to accepted Identity or Atropa conclusions",
]);
export const CONDITION4_CANONICAL_RATIONALE =
  "The Investor specialist assessed the exact 843,579,441.647005259136001133 PLSX pass-through from source/helper 0x60719573BEAa21421a92D86657866121c8b21892 to target 0x8f56AA97ebef8080144FB21224E46a5D85657C23 and destination 0xB00d08E09FA48c2E1D48ac3EdE2fFea354341215. The full downstream PulseX swap yielded 7,847.337744 USDC token units and reached HomeOmnibridge initiation; 1.084314 USDC bounded commingling was separated from the accepted phPLSX reserve drawdown, leaving the exact double-count amount of zero. There is no proven lending position and no proven public-exchange deposit. Accepted Identity and Atropa conclusions remain unchanged. This is historical evidence analysis only and changes no portfolio, wallet, order, transaction, execution, or trading state.";
export function condition4CanonicalBlockedRationale(missingRecordId) {
  return `The exact accepted record ${missingRecordId} is missing, so the bounded Investor dependency assessment cannot reach a supported conclusion. No publication or replacement research task is authorized. No specialist pointer, identity conclusion, portfolio, wallet, order, transaction, execution, or trading state changes.`;
}

export const EVENT_TYPES = Object.freeze([
  "OWNER_QUESTION_ACCEPTED",
  "HEAD_CHEF_REVIEW_REQUEST",
  "HEAD_CHEF_ASSIGNMENT_CREATED",
  "HEAD_CHEF_ASSIGNMENT_ACKNOWLEDGED",
  "SPECIALIST_RESULT_POSTED",
  "HEAD_CHEF_FOLLOW_UP_REQUESTED",
  "SPECIALIST_PUBLICATION_REQUESTED",
  "SPECIALIST_PUBLICATION_ACCEPTED",
  "SPECIALIST_NO_CHANGE_ACCEPTED",
  "SPECIALIST_EVIDENCE_BLOCKED",
  "OWNER_GATE_REQUIRED",
  "HEAD_CHEF_CLOSURE_CREATED",
  "WORKER_5_DELIVERY_ACKNOWLEDGED",
  "HEAD_CHEF_CHECKPOINT",
]);

export const PRIORITIES = Object.freeze(["URGENT", "HIGH", "MEDIUM", "ROUTINE"]);

export const SPECIALIST_PAIRS = Object.freeze({
  "chatgpt-worker-1": "signals-platform",
  "chatgpt-worker-2": "validator-flows",
  "chatgpt-worker-3": "identity-attribution",
  "chatgpt-worker-4": "investor-intelligence",
});

const EVENT_TYPE_SET = new Set(EVENT_TYPES);
const PRIORITY_SET = new Set(PRIORITIES);
const TARGET_BOUND_EVENT_TYPES = new Set([
  "HEAD_CHEF_ASSIGNMENT_CREATED",
  "HEAD_CHEF_ASSIGNMENT_ACKNOWLEDGED",
  "SPECIALIST_RESULT_POSTED",
  "HEAD_CHEF_FOLLOW_UP_REQUESTED",
  "SPECIALIST_PUBLICATION_REQUESTED",
  "SPECIALIST_PUBLICATION_ACCEPTED",
  "SPECIALIST_NO_CHANGE_ACCEPTED",
  "SPECIALIST_EVIDENCE_BLOCKED",
]);
const HEAD_CHEF_TARGET_EVENT_TYPES = new Set([
  "OWNER_QUESTION_ACCEPTED",
  "HEAD_CHEF_REVIEW_REQUEST",
  "HEAD_CHEF_CHECKPOINT",
]);
const WORKER_5_TARGET_EVENT_TYPES = new Set([
  "OWNER_GATE_REQUIRED",
  "HEAD_CHEF_CLOSURE_CREATED",
  "WORKER_5_DELIVERY_ACKNOWLEDGED",
]);

const EVENT_FIELDS = Object.freeze([
  "assignment_id",
  "canonical_duplicate_key",
  "content_sha256",
  "coordination_id",
  "created_at_utc",
  "decision_class",
  "dependencies",
  "event_id",
  "event_type",
  "owner_question_id",
  "priority",
  "requested_decision",
  "schema_version",
  "source_record_ids",
  "summary",
  "target_worker_id",
  "target_workstream_id",
]);

const SOURCE_FIELDS = Object.freeze([
  "actor",
  "actor_id",
  "body_sha256",
  "comment_id",
  "comment_node_id",
  "comment_url",
  "event_action",
  "event_name",
  "issue_node_id",
  "issue_number",
  "issue_title",
  "issue_url",
  "ref",
  "repository",
  "repository_id",
  "repository_owner_id",
  "run_attempt",
  "run_id",
  "workflow_ref",
  "workflow_sha",
]);

const RECEIPT_FIELDS = Object.freeze([
  "accepted",
  "canonical_duplicate_key",
  "content_sha256",
  "coordination_id",
  "event_id",
  "replayed",
  "run_attempt",
  "run_id",
  "schema_version",
  "source_comment_id",
  "source_issue_number",
]);
const REJECTION_FIELDS = Object.freeze(["accepted", "error", "schema_version"]);

const SECRET_PATTERN =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|gh[oprsu]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{20,}|\b(?:password|passwd|secret|token|cookie|authorization|private[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*[^\s,}]{8,})/i;

const PROTECTED_ACTION_PATTERNS = [
  /\b(?:execute|submit|place|sign|broadcast|send|transfer|withdraw|deposit|buy|sell|swap|bridge)\b[\s\S]{0,80}\b(?:orders?|transactions?|trades?|funds?|assets?|tokens?|wallet|portfolio)\b/i,
  /\b(?:place|create|open|cancel|submit|execute|perform|commit|route|launch|make|sign|broadcast|initiate|approve|authorize)\b[^.!?\n]{0,100}\b(?:trades?|orders?|transactions?|transfer|swap|bridge|withdrawal|deposit|wallet|portfolio|position)\b/i,
  /\b(?:send|move|route|transfer|bridge|swap|withdraw|deposit|buy|sell|trade|sweep|convert|stake|unstake|rebalance|delegate|mint|burn|wrap|unwrap|lend|borrow|repay|redeem|liquidate|allocate|commit|dispose|drain|fund|pay|wire|remit|collect|harvest|grant|revoke)\b[^.!?\n]{0,100}\b(?:funds?|assets?|tokens?|coins?|wallet|treasury|balance|portfolio|position|orders?|trades?|transactions?|address|rewards?|fees?|allowance|pls|wpls|plsx|usdc|eth|lp)\b/i,
  /\b(?:deploy|apply|patch|repair|configure|change|modify|restart|rerun|enable|disable|delete|erase|destroy|remove|drop|truncate|migrate|run|push|merge|rewrite)\b[^.!?\n]{0,100}\b(?:production|provider|schema|database|migration|credentials?|secrets?|workflow|schedule|gateway|traffic|main|trading|execution)\b/i,
  /\b(?:turn\s+(?:on|off)|enable|activate)\b[^.!?\n]{0,60}\b(?:trading|execution|wallet)\b/i,
  /\b(?:send|transfer|swap|bridge|withdraw|deposit|buy|sell|stake|unstake|convert|sweep|lend|borrow|repay|mint|burn)\s+(?:\d[\d,]*(?:\.\d+)?|[A-Z][A-Z0-9]{1,11})\b/,
];
// Scan only complete, standalone prohibitions in an owner-intake summary.
// Keep original bytes/hashes and all other fields/events unchanged. Ambiguous
// or conditional wording stays gated; there is no research-only exemption.
function ownerIntakeSafetySurface(eventType, summary) {
  if (eventType !== "OWNER_QUESTION_ACCEPTED") return summary;
  const action = "(?:move funds|execute transactions|sign transactions|broadcast transactions|transfer funds|transfer assets|trade assets|trade tokens|buy tokens|sell tokens|swap tokens)";
  const prohibition = new RegExp("(^|[.!?\\n])([ \\t]*)(?:Do not|Never)[ \\t]+" + action + "(?:(?:, |,? and |,? or )" + action + ")*[ \\t]*(?=\\.(?:\\s|$))", "gi");
  return summary.replace(prohibition, "$1$2[EXPLICIT_NO_FINANCIAL_ACTION]");
}
const CONDITION4_IMPERATIVE_ACTION_PATTERNS = [
  /(?:^|[\n.!?;:]\s*)(?:please\s+)?(?:execute|perform|initiate|route|move|send|transfer|swap|bridge|withdraw|deposit|buy|sell|trade|drain|dispose|pay|wire|deploy|apply|run|enable|disable)\b/i,
  /\b(?:must|should|shall|authorize|approve|instruct|order)\b[^.!?\n]{0,80}\b(?:execute|perform|initiate|route|move|send|transfer|swap|bridge|withdraw|deposit|buy|sell|trade|drain|dispose|pay|wire|deploy|apply|run|enable|disable)\b/i,
];
const CONDITION4_RATIONALE_SUFFIX_ACTION_PATTERN =
  /\b(?:execut(?:e|es|ed|ing|ion)|perform(?:s|ed|ing|ance)?|initiat(?:e|es|ed|ing|ion)|rout(?:e|es|ed|ing)|mov(?:e|es|ed|ing)|send(?:s|ing)?|sent|transfer(?:s|red|ring)?|swap(?:s|ped|ping)?|bridg(?:e|es|ed|ing)|withdraw(?:s|al|als|n|ing)?|deposit(?:s|ed|ing)?|buy(?:s|ing)?|bought|sell(?:s|ing)?|sold|trad(?:e|es|ed|ing)|drain(?:s|ed|ing)?|dispos(?:e|es|ed|ing)|pay(?:s|ing)?|paid|wir(?:e|es|ed|ing)|deploy(?:s|ed|ing|ment)?|appl(?:y|ies|ied|ying)|run(?:s|ning)?|ran|enabl(?:e|es|ed|ing)|disabl(?:e|es|ed|ing))\b/i;
function maskCondition4FactualPhrases(event, value) {
  const reviewed = event.decision_class === "BLOCKED_MISSING_ACCEPTED_EVIDENCE" &&
      event.dependencies.length === 1
    ? condition4CanonicalBlockedRationale(event.dependencies[0])
    : CONDITION4_CANONICAL_RATIONALE;
  return value.replace(reviewed, "[CONDITION4_REVIEWED_RATIONALE]");
}

export class HeadChefCoordinationIngestError extends Error {
  constructor(code, detail = "", { mayHaveCommitted = false } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "HeadChefCoordinationIngestError";
    this.code = code;
    this.mayHaveCommitted = mayHaveCommitted;
  }
}

function fail(code, detail = "", options = undefined) {
  throw new HeadChefCoordinationIngestError(code, detail, options);
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value) fail(`${name}_REQUIRED`);
  return value;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) fail("INVALID_OBJECT", label);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("INVALID_FIELD_SET", label);
}

function safeText(value, label, maximum, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    value.includes("\0") ||
    /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    fail("INVALID_TEXT", label);
  }
  if (SECRET_PATTERN.test(value)) fail("SECRET_PATTERN_REJECTED", label);
  return value.trim();
}

function safePositiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail("INVALID_INTEGER", label);
  return value;
}

function safeStringList(value, label, { maximum = 32, pattern = null } = {}) {
  if (!Array.isArray(value) || value.length > maximum) fail("INVALID_LIST", label);
  const result = value.map((entry, index) => safeText(entry, `${label}[${index}]`, 512));
  if (pattern && result.some((entry) => !pattern.test(entry))) fail("INVALID_LIST_IDENTITY", label);
  if (new Set(result).size !== result.length) fail("DUPLICATE_LIST_VALUE", label);
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1] >= result[index]) fail("LIST_ORDER_NOT_CANONICAL", label);
  }
  if (Buffer.byteLength(canonicalJson(result), "utf8") > 8_192) fail("LIST_STORAGE_LIMIT", label);
  return result;
}

function canonicalTimestamp(value, label) {
  const text = safeText(value, label, 80);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== text) fail("INVALID_TIME", label);
  if (parsed.valueOf() > Date.now() + 5 * 60 * 1_000) fail("FUTURE_TIME_REJECTED", label);
  return text;
}

function githubTimestamp(value, label) {
  if (typeof value !== "string" || !GITHUB_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    fail("INVALID_GITHUB_TIME", label);
  }
  return Date.parse(value);
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("NON_CANONICAL_JSON_VALUE");
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function coordinationIdForQuestion(questionId) {
  if (!QUESTION_ID.test(questionId)) fail("INVALID_QUESTION_ID");
  const digest = sha256(Buffer.from(questionId, "utf8")).slice("sha256:".length);
  return `head-chef-coordination-${digest}`;
}

function canonicalDuplicateMaterial(value) {
  return {
    assignment_id: value.assignment_id,
    coordination_id: value.coordination_id,
    decision_class: value.decision_class,
    dependencies: value.dependencies,
    event_type: value.event_type,
    owner_question_id: value.owner_question_id,
    priority: value.priority,
    requested_decision: value.requested_decision,
    schema_version: value.schema_version,
    source_record_ids: value.source_record_ids,
    summary: value.summary,
    target_worker_id: value.target_worker_id,
    target_workstream_id: value.target_workstream_id,
  };
}

export function canonicalDuplicateKeyForEvent(value) {
  return sha256(Buffer.from(canonicalJson(canonicalDuplicateMaterial(value)), "utf8"));
}

export function contentSha256ForEvent(value) {
  const { content_sha256: _contentSha256, ...withoutContentHash } = value;
  return sha256(Buffer.from(canonicalJson(withoutContentHash), "utf8"));
}

function validateEventSemantics(event, sourceKind) {
  if (TARGET_BOUND_EVENT_TYPES.has(event.event_type)) {
    if (!SAFE_ID.test(event.assignment_id || "")) fail("ASSIGNMENT_ID_REQUIRED", event.event_type);
    const expectedWorkstream = SPECIALIST_PAIRS[event.target_worker_id];
    if (!expectedWorkstream || event.target_workstream_id !== expectedWorkstream) {
      fail("WORKER_WORKSTREAM_MISMATCH", `${event.target_worker_id}/${event.target_workstream_id}`);
    }
  } else {
    if (event.assignment_id !== null) fail("EVENT_FORBIDS_ASSIGNMENT_ID", event.event_type);
    const expectedPair = HEAD_CHEF_TARGET_EVENT_TYPES.has(event.event_type)
      ? ["chatgpt-head-chef", "head-chef-coordination"]
      : WORKER_5_TARGET_EVENT_TYPES.has(event.event_type)
        ? ["chatgpt-worker-5", "inquisitor-owner-front-door"]
        : null;
    if (
      !expectedPair ||
      event.target_worker_id !== expectedPair[0] ||
      event.target_workstream_id !== expectedPair[1]
    ) {
      fail("WORKER_WORKSTREAM_MISMATCH", `${event.target_worker_id}/${event.target_workstream_id}`);
    }
  }
  if (event.event_type === "SPECIALIST_PUBLICATION_ACCEPTED" && event.source_record_ids.length !== 1) {
    fail("ACCEPTED_PUBLICATION_REQUIRES_SOURCE_RECORD");
  }
  if (
    event.event_type === "SPECIALIST_NO_CHANGE_ACCEPTED" &&
    (event.decision_class !== "VALIDATED_NO_CHANGE_NO_PUBLICATION_REQUIRED" || event.summary.length < 120)
  ) {
    fail("NO_CHANGE_RATIONALE_INVALID");
  }
  validateCondition4ResearchSemantics(event);
  if (sourceKind === "issue") {
    if (event.event_type !== "OWNER_QUESTION_ACCEPTED") fail("INVALID_OPENING_EVENT_TYPE", event.event_type);
  } else if (event.event_type === "OWNER_QUESTION_ACCEPTED") {
    fail("OWNER_QUESTION_REQUIRES_OPENING_ISSUE");
  }
}

function exactCondition4ResearchBase(event) {
  return (
    event.coordination_id === CONDITION4_COORDINATION_ID &&
    event.assignment_id !== null &&
    event.priority === "HIGH" &&
    event.target_worker_id === "chatgpt-worker-4" &&
    event.target_workstream_id === "investor-intelligence" &&
    event.source_record_ids.length === 1 &&
    event.source_record_ids[0] === CONDITION4_SOURCE_RECORD_ID
  );
}

function hasCompleteCondition4Rationale(summary) {
  return (
    typeof summary === "string" &&
    summary.startsWith(CONDITION4_CANONICAL_RATIONALE)
  );
}

function validateCondition4ResearchSemantics(event) {
  if (
    event.coordination_id === CONDITION4_COORDINATION_ID &&
    event.event_type === "SPECIALIST_PUBLICATION_ACCEPTED"
  ) {
    if (
      event.assignment_id === null ||
      event.target_worker_id !== "chatgpt-worker-4" ||
      event.target_workstream_id !== "investor-intelligence" ||
      event.decision_class !== "MATERIAL_IMPORT_PUBLICATION_REQUIRED" ||
      event.source_record_ids.length !== 1 ||
      !event.source_record_ids[0].startsWith("investor-intelligence-") ||
      event.source_record_ids[0] === CONDITION4_SOURCE_RECORD_ID ||
      event.source_record_ids[0] === CONDITION4_PRIOR_INVESTOR_UPDATE_ID
    ) {
      fail("CONDITION4_PUBLICATION_RECEIPT_INVALID");
    }
    return;
  }
  if (
    event.coordination_id !== CONDITION4_COORDINATION_ID ||
    !CONDITION4_RESEARCH_EVENT_TYPES.has(event.event_type)
  ) {
    return;
  }
  if (!exactCondition4ResearchBase(event)) {
    fail("CONDITION4_RESEARCH_EVENT_INVALID", "identity or accepted source");
  }
  let expectedDecision = null;
  if (event.event_type === "SPECIALIST_RESULT_POSTED") {
    if (!CONDITION4_TERMINAL_DECISIONS.has(event.decision_class)) {
      fail("CONDITION4_RESEARCH_EVENT_INVALID", "unsupported outcome");
    }
    expectedDecision = event.decision_class;
  } else if (event.event_type === "SPECIALIST_PUBLICATION_REQUESTED") {
    expectedDecision = "MATERIAL_IMPORT_PUBLICATION_REQUIRED";
  } else if (event.event_type === "SPECIALIST_NO_CHANGE_ACCEPTED") {
    expectedDecision = "VALIDATED_NO_CHANGE_NO_PUBLICATION_REQUIRED";
  } else if (event.event_type === "SPECIALIST_EVIDENCE_BLOCKED") {
    expectedDecision = "BLOCKED_MISSING_ACCEPTED_EVIDENCE";
  }
  if (event.decision_class !== expectedDecision) {
    fail("CONDITION4_RESEARCH_EVENT_INVALID", "event type and outcome differ");
  }
  if (
    expectedDecision === "MATERIAL_IMPORT_PUBLICATION_REQUIRED" ||
    expectedDecision === "VALIDATED_NO_CHANGE_NO_PUBLICATION_REQUIRED"
  ) {
    if (event.dependencies.length !== 0 || !hasCompleteCondition4Rationale(event.summary)) {
      fail("CONDITION4_RATIONALE_INCOMPLETE");
    }
    return;
  }
  if (
    event.dependencies.length !== 1 ||
    event.summary !== condition4CanonicalBlockedRationale(event.dependencies[0])
  ) {
    fail("CONDITION4_BLOCKER_EVIDENCE_INVALID");
  }
}

function isExactCondition4ResearchEvent(event) {
  return (
    exactCondition4ResearchBase(event) &&
    CONDITION4_RESEARCH_EVENT_TYPES.has(event.event_type) &&
    (event.decision_class === "BLOCKED_MISSING_ACCEPTED_EVIDENCE" ||
      hasCompleteCondition4Rationale(event.summary))
  );
}

function isExactCondition4PublicationReceiptCandidate(event) {
  return (
    event.coordination_id === CONDITION4_COORDINATION_ID &&
    event.event_type === "SPECIALIST_PUBLICATION_ACCEPTED" &&
    event.assignment_id !== null &&
    event.priority === "HIGH" &&
    event.target_worker_id === "chatgpt-worker-4" &&
    event.target_workstream_id === "investor-intelligence" &&
    event.decision_class === "MATERIAL_IMPORT_PUBLICATION_REQUIRED" &&
    event.source_record_ids.length === 1 &&
    event.source_record_ids[0].startsWith("investor-intelligence-") &&
    event.source_record_ids[0] !== CONDITION4_SOURCE_RECORD_ID &&
    event.source_record_ids[0] !== CONDITION4_PRIOR_INVESTOR_UPDATE_ID &&
    event.dependencies.length === 0 &&
    hasCompleteCondition4Rationale(event.summary)
  );
}

function isExactCondition4ProtectedActionException(event) {
  return (
    event.coordination_id === CONDITION4_COORDINATION_ID &&
    event.event_type === "HEAD_CHEF_ASSIGNMENT_CREATED" &&
    event.priority === "HIGH" &&
    event.target_worker_id === "chatgpt-worker-4" &&
    event.target_workstream_id === "investor-intelligence" &&
    event.decision_class === CONDITION4_DECISION_CLASS &&
    event.source_record_ids.length === 1 &&
    event.source_record_ids[0] === CONDITION4_SOURCE_RECORD_ID &&
    event.dependencies.length === 0 &&
    event.requested_decision === CONDITION4_REQUESTED_DECISION
  );
}

export function validateEventDocument(value, { sourceKind = "comment" } = {}) {
  exactKeys(value, EVENT_FIELDS, "event");
  if (value.schema_version !== EVENT_SCHEMA || !EVENT_TYPE_SET.has(value.event_type)) {
    fail("INVALID_EVENT_SCHEMA_OR_TYPE");
  }
  if (!QUESTION_ID.test(value.owner_question_id || "")) fail("INVALID_QUESTION_ID");
  if (!SAFE_ID.test(value.coordination_id || "")) fail("INVALID_COORDINATION_IDENTITY");
  if (!SAFE_ID.test(value.event_id || "")) fail("INVALID_EVENT_ID");
  if (!PRIORITY_SET.has(value.priority)) fail("INVALID_PRIORITY");
  const decisionClass = safeText(value.decision_class, "decision_class", 128, { nullable: true });
  if (decisionClass !== null && !SAFE_CLASSIFICATION.test(decisionClass)) fail("INVALID_DECISION_CLASS");
  const requestedDecision = safeText(value.requested_decision, "requested_decision", 4_096, { nullable: true });
  const summary = safeText(value.summary, "summary", 8_192);
  const sourceRecordIds = safeStringList(value.source_record_ids, "source_record_ids", { pattern: RECORD_ID });
  const dependencies = safeStringList(value.dependencies, "dependencies", { pattern: RECORD_ID });
  const createdAt = canonicalTimestamp(value.created_at_utc, "created_at_utc");
  const normalized = {
    ...value,
    decision_class: decisionClass,
    requested_decision: requestedDecision,
    source_record_ids: sourceRecordIds,
    dependencies,
    summary,
    created_at_utc: createdAt,
  };
  if (SECRET_PATTERN.test(canonicalJson(normalized))) fail("SECRET_PATTERN_REJECTED", "event");
  const protectedRequestedDecision = requestedDecision !== null &&
    PROTECTED_ACTION_PATTERNS.some((pattern) => pattern.test(requestedDecision));
  const protectedUnexceptionableSurface = [
    decisionClass?.replace(/[_-]+/g, " ") ?? "",
    ownerIntakeSafetySurface(normalized.event_type, summary),
    ...dependencies,
  ].join("\n");
  const condition4ResearchSurface = [
    decisionClass?.replace(/[_-]+/g, " ") ?? "",
    requestedDecision ?? "",
    summary,
    ...dependencies,
  ].join("\n");
  const exactCondition4ResearchEvent = isExactCondition4ResearchEvent(normalized);
  const condition4ProtectedEvent =
    exactCondition4ResearchEvent ||
    isExactCondition4PublicationReceiptCandidate(normalized);
  const condition4MaskedSurface = condition4ProtectedEvent
    ? maskCondition4FactualPhrases(normalized, condition4ResearchSurface)
    : condition4ResearchSurface;
  const condition4MaskedDecisionAndSummary = condition4ProtectedEvent
    ? maskCondition4FactualPhrases(
        normalized,
        [decisionClass?.replace(/[_-]+/g, " ") ?? "", summary].join("\n"),
      )
    : protectedUnexceptionableSurface;
  if (
    (condition4ProtectedEvent
      ? CONDITION4_IMPERATIVE_ACTION_PATTERNS.some((pattern) =>
          pattern.test(protectedUnexceptionableSurface)) ||
        CONDITION4_RATIONALE_SUFFIX_ACTION_PATTERN.test(condition4MaskedDecisionAndSummary) ||
        PROTECTED_ACTION_PATTERNS.some((pattern) =>
          pattern.test(condition4MaskedSurface))
      : PROTECTED_ACTION_PATTERNS.some((pattern) =>
          pattern.test(protectedUnexceptionableSurface)) ||
        (protectedRequestedDecision && !isExactCondition4ProtectedActionException(normalized)))
  ) {
    fail("PROTECTED_ACTION_REJECTED");
  }
  validateEventSemantics(normalized, sourceKind);
  if (!SHA256.test(value.canonical_duplicate_key || "")) fail("INVALID_CANONICAL_DUPLICATE_KEY");
  if (value.canonical_duplicate_key !== canonicalDuplicateKeyForEvent(normalized)) {
    fail("CANONICAL_DUPLICATE_KEY_MISMATCH");
  }
  if (!SHA256.test(value.content_sha256 || "")) fail("INVALID_CONTENT_SHA256");
  if (value.content_sha256 !== contentSha256ForEvent(normalized)) fail("CONTENT_SHA256_MISMATCH");
  if (canonicalJson(value) !== canonicalJson(normalized)) fail("NON_CANONICAL_EVENT_VALUE");
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > MAX_BODY_BYTES) fail("EVENT_TOO_LARGE");
  return normalized;
}

export function parseEventBody(body, { sourceKind = "comment" } = {}) {
  if (typeof body !== "string") return null;
  if (body.startsWith(RECEIPT_MARKER)) return null;
  const claimsGovernedSchema =
    /"schema_version"\s*:\s*"pulsechain-head-chef-event@1\.0\.0"/.test(body);
  if (!claimsGovernedSchema) return null;
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    fail("BODY_MISSING_OR_TOO_LARGE");
  }
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    fail("MALFORMED_EVENT_JSON");
  }
  if (!plainObject(value)) fail("EVENT_OBJECT_REQUIRED");
  const event = validateEventDocument(value, { sourceKind });
  if (body.trim() !== canonicalJson(event)) fail("NON_CANONICAL_EVENT_JSON");
  return event;
}

export function ignoredEventReason(event, env = process.env) {
  const eventName = env.GITHUB_EVENT_NAME;
  const action = event?.action ?? env.GITHUB_EVENT_ACTION;
  if (eventName === "issues" && action !== "opened") return "ISSUE_ACTION_NOT_OPENED";
  if (eventName === "issue_comment" && action !== "created") return "COMMENT_ACTION_NOT_CREATED";
  if (
    eventName === "issue_comment" &&
    event?.comment?.body?.startsWith(RECEIPT_MARKER) &&
    event?.comment?.user?.login === BOT_LOGIN &&
    String(event?.comment?.user?.id) === BOT_ID
  ) {
    return "OWN_MACHINE_RECEIPT";
  }
  return null;
}

export function validateRuntimeEnvironment(env = process.env) {
  const expectedWorkflowRef = `${REPOSITORY}/${WORKFLOW_PATH}@${REF}`;
  const runId = Number(required(env, "GITHUB_RUN_ID"));
  const runAttempt = Number(required(env, "GITHUB_RUN_ATTEMPT"));
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    String(env.GITHUB_REPOSITORY_ID) !== REPOSITORY_ID ||
    env.GITHUB_REPOSITORY_OWNER !== REPOSITORY_OWNER ||
    String(env.GITHUB_REPOSITORY_OWNER_ID) !== REPOSITORY_OWNER_ID ||
    env.GITHUB_ACTOR !== AUTHORIZED_ACTOR ||
    String(env.GITHUB_ACTOR_ID) !== AUTHORIZED_ACTOR_ID ||
    env.GITHUB_TRIGGERING_ACTOR !== AUTHORIZED_ACTOR ||
    env.GITHUB_REF !== REF ||
    !["issues", "issue_comment"].includes(env.GITHUB_EVENT_NAME) ||
    !["opened", "created"].includes(env.GITHUB_EVENT_ACTION) ||
    env.GITHUB_WORKFLOW_REF !== expectedWorkflowRef ||
    !COMMIT.test(env.GITHUB_SHA || "") ||
    !COMMIT.test(env.GITHUB_WORKFLOW_SHA || "") ||
    env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA ||
    env.GITHUB_SERVER_URL !== "https://github.com" ||
    env.GITHUB_API_URL !== "https://api.github.com"
  ) {
    fail("GITHUB_RUNTIME_IDENTITY_MISMATCH");
  }
  safePositiveInteger(runId, "GITHUB_RUN_ID");
  safePositiveInteger(runAttempt, "GITHUB_RUN_ATTEMPT", 100);
  return { expectedWorkflowRef, runId, runAttempt, workflowSha: env.GITHUB_WORKFLOW_SHA };
}

function validateIssueIdentity(issue) {
  if (
    !plainObject(issue) ||
    !Number.isSafeInteger(issue.number) ||
    issue.number < 1 ||
    !ISSUE_NODE_ID.test(issue.node_id || "") ||
    issue.html_url !== `https://github.com/${REPOSITORY}/issues/${issue.number}` ||
    issue.url !== `https://api.github.com/repos/${REPOSITORY}/issues/${issue.number}` ||
    issue.repository_url !== `https://api.github.com/repos/${REPOSITORY}` ||
    !GITHUB_TIMESTAMP.test(issue.created_at || "") ||
    Number.isNaN(Date.parse(issue.created_at)) ||
    issue.state !== "open" ||
    "pull_request" in issue ||
    issue.user?.login !== AUTHORIZED_ACTOR ||
    String(issue.user?.id) !== AUTHORIZED_ACTOR_ID
  ) {
    fail("INVALID_HEAD_CHEF_ISSUE_IDENTITY");
  }
}

function validateCommentIdentity(comment, issue) {
  if (
    !plainObject(comment) ||
    !Number.isSafeInteger(comment.id) ||
    comment.id < 1 ||
    !COMMENT_NODE_ID.test(comment.node_id || "") ||
    comment.html_url !== `${issue.html_url}#issuecomment-${comment.id}` ||
    comment.issue_url !== `https://api.github.com/repos/${REPOSITORY}/issues/${issue.number}` ||
    !GITHUB_TIMESTAMP.test(comment.created_at || "") ||
    Number.isNaN(Date.parse(comment.created_at)) ||
    comment.user?.login !== AUTHORIZED_ACTOR ||
    String(comment.user?.id) !== AUTHORIZED_ACTOR_ID
  ) {
    fail("INVALID_HEAD_CHEF_COMMENT_IDENTITY");
  }
}

export function validateGitHubEvent(event, env = process.env) {
  const runtime = validateRuntimeEnvironment(env);
  const eventName = env.GITHUB_EVENT_NAME;
  if (
    !plainObject(event) ||
    event.action !== env.GITHUB_EVENT_ACTION ||
    event.repository?.full_name !== REPOSITORY ||
    String(event.repository?.id) !== REPOSITORY_ID ||
    event.repository?.owner?.login !== REPOSITORY_OWNER ||
    String(event.repository?.owner?.id) !== REPOSITORY_OWNER_ID ||
    event.sender?.login !== AUTHORIZED_ACTOR ||
    String(event.sender?.id) !== AUTHORIZED_ACTOR_ID
  ) {
    fail("FOREIGN_REPOSITORY_OR_ACTOR");
  }
  validateIssueIdentity(event.issue);
  if (eventName === "issues" && event.comment !== undefined) fail("ISSUE_EVENT_HAS_COMMENT");
  if (eventName === "issue_comment") validateCommentIdentity(event.comment, event.issue);
  const sourceKind = eventName === "issues" ? "issue" : "comment";
  const body = eventName === "issues" ? event.issue.body : event.comment.body;
  const document = parseEventBody(body, { sourceKind });
  if (!document) return null;
  const expectedTitle = `${TITLE_PREFIX}${document.coordination_id}`;
  if (event.issue.title !== expectedTitle) fail("HEAD_CHEF_ISSUE_TITLE_MISMATCH", expectedTitle);
  return { runtime, eventName, sourceKind, document, body, issue: event.issue, comment: event.comment ?? null };
}

async function boundedJsonResponse(response, label, maximumBytes) {
  const claimed = Number(response.headers?.get?.("content-length") ?? 0);
  if (!Number.isFinite(claimed) || claimed < 0 || claimed > maximumBytes) fail(`${label}_RESPONSE_TOO_LARGE`);
  let text;
  try {
    text = await response.text();
  } catch {
    fail(`${label}_RESPONSE_UNREADABLE`);
  }
  if (Buffer.byteLength(text, "utf8") > maximumBytes) fail(`${label}_RESPONSE_TOO_LARGE`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`${label}_RESPONSE_NON_JSON`);
  }
  return value;
}

export function transitionProjectionUrl(coordinationId) {
  if (!SAFE_ID.test(coordinationId || "")) fail("INVALID_COORDINATION_IDENTITY");
  return `${CONTROL_ROOM_ORIGIN}/api/v1/head-chef/questions/${encodeURIComponent(coordinationId)}`;
}

function projectionEvents(value) {
  if (!Array.isArray(value.events) || value.events.length > 4_096) {
    fail("CONTROL_ROOM_TRANSITION_PROJECTION_INVALID", "events");
  }
  return value.events.map((record, index) => {
    if (
      !plainObject(record) ||
      typeof record.event_id !== "string" ||
      !SAFE_ID.test(record.event_id) ||
      typeof record.event_type !== "string" ||
      !EVENT_TYPE_SET.has(record.event_type) ||
      typeof record.canonical_duplicate_key !== "string" ||
      !SHA256.test(record.canonical_duplicate_key) ||
      typeof record.content_sha256 !== "string" ||
      !SHA256.test(record.content_sha256) ||
      !plainObject(record.event)
    ) {
      fail("CONTROL_ROOM_TRANSITION_PROJECTION_INVALID", `events[${index}]`);
    }
    if (
      record.event.event_id !== record.event_id ||
      record.event.event_type !== record.event_type ||
      record.event.canonical_duplicate_key !== record.canonical_duplicate_key ||
      record.event.content_sha256 !== record.content_sha256
    ) {
      fail("CONTROL_ROOM_TRANSITION_PROJECTION_INVALID", `events[${index}].identity`);
    }
    return record;
  });
}

function projectionAssignments(value) {
  if (!Array.isArray(value.assignments) || value.assignments.length > 128) {
    fail("CONTROL_ROOM_TRANSITION_PROJECTION_INVALID", "assignments");
  }
  return value.assignments.map((assignment, index) => {
    if (
      !plainObject(assignment) ||
      typeof assignment.assignment_id !== "string" ||
      !SAFE_ID.test(assignment.assignment_id) ||
      typeof assignment.target_worker_id !== "string" ||
      typeof assignment.target_workstream_id !== "string" ||
      SPECIALIST_PAIRS[assignment.target_worker_id] !== assignment.target_workstream_id ||
      !PRIORITY_SET.has(assignment.priority) ||
      !(
        assignment.decision_class === null ||
        (typeof assignment.decision_class === "string" &&
          SAFE_CLASSIFICATION.test(assignment.decision_class))
      ) ||
      !(
        assignment.requested_decision === null ||
        (typeof assignment.requested_decision === "string" &&
          assignment.requested_decision.length <= 4_096)
      ) ||
      !Array.isArray(assignment.source_record_ids) ||
      assignment.source_record_ids.some(
        (recordId) => typeof recordId !== "string" || !RECORD_ID.test(recordId),
      ) ||
      !Array.isArray(assignment.dependencies) ||
      assignment.dependencies.some(
        (recordId) => typeof recordId !== "string" || !RECORD_ID.test(recordId),
      ) ||
      typeof assignment.acknowledged !== "boolean" ||
      !Number.isSafeInteger(assignment.follow_up_count) ||
      assignment.follow_up_count < 0 ||
      assignment.follow_up_count > 3 ||
      typeof assignment.publication_requested !== "boolean" ||
      !(
        assignment.terminal_event_id === null ||
        (typeof assignment.terminal_event_id === "string" &&
          SAFE_ID.test(assignment.terminal_event_id))
      ) ||
      typeof assignment.state !== "string" ||
      !ASSIGNMENT_STATES.has(assignment.state)
    ) {
      fail("CONTROL_ROOM_TRANSITION_PROJECTION_INVALID", `assignments[${index}]`);
    }
    if (
      (assignment.terminal_event_id === null && TERMINAL_ASSIGNMENT_STATES.has(assignment.state)) ||
      (assignment.terminal_event_id !== null && !TERMINAL_ASSIGNMENT_STATES.has(assignment.state))
    ) {
      fail("CONTROL_ROOM_TRANSITION_PROJECTION_INVALID", `assignments[${index}].terminal`);
    }
    return assignment;
  });
}

function transitionPending(detail) {
  fail("CONTROL_ROOM_TRANSITION_PREREQUISITE_PENDING", detail);
}

function transitionInvalid(detail) {
  fail("CONTROL_ROOM_TRANSITION_PREFLIGHT_REJECTED", detail);
}

/**
 * Validate the event against the public Control Room projection before asking
 * GitHub for an OIDC token. The Control Room POST remains the final authority;
 * this preflight independently rejects obvious cross-assignment and
 * out-of-order actions while allowing a bounded wait for a prior workflow run
 * to finish ingesting its prerequisite event.
 */
export function validateTransitionProjection(
  event,
  projection,
  { sourceIssueNumber } = {},
) {
  if (!Number.isSafeInteger(sourceIssueNumber) || sourceIssueNumber < 1) {
    fail("CONTROL_ROOM_TRANSITION_PROJECTION_INVALID", "source issue");
  }
  if (projection === null) {
    if (event.event_type === "OWNER_QUESTION_ACCEPTED") {
      return { replayed: false, transition: "OWNER_QUESTION_ACCEPTED" };
    }
    transitionPending("owner question has not reached the Control Room");
  }
  if (
    !plainObject(projection) ||
    projection.schema_version !== "pulsechain-head-chef-question@1.0.0" ||
    projection.coordination_id !== event.coordination_id ||
    projection.owner_question_id !== event.owner_question_id ||
    projection.source_issue_number !== sourceIssueNumber ||
    !PROJECTION_STATES.has(projection.current_state)
  ) {
    fail("CONTROL_ROOM_TRANSITION_PROJECTION_INVALID", "coordination identity");
  }

  const events = projectionEvents(projection);
  const assignments = projectionAssignments(projection);
  if (
    events.some(
      (record) =>
        record.event.coordination_id !== event.coordination_id ||
        record.event.owner_question_id !== event.owner_question_id,
    ) ||
    new Set(assignments.map((assignment) => assignment.assignment_id)).size !== assignments.length
  ) {
    fail("CONTROL_ROOM_TRANSITION_PROJECTION_INVALID", "projection member identity");
  }
  const exactReplay = events.find((record) => record.event_id === event.event_id);
  if (exactReplay) {
    if (
      exactReplay.canonical_duplicate_key !== event.canonical_duplicate_key ||
      exactReplay.content_sha256 !== event.content_sha256 ||
      canonicalJson(exactReplay.event) !== canonicalJson(event)
    ) {
      transitionInvalid("event_id conflicts with accepted projection");
    }
    return { replayed: true, transition: event.event_type };
  }
  if (
    events.some(
      (record) =>
        record.canonical_duplicate_key === event.canonical_duplicate_key ||
        record.content_sha256 === event.content_sha256,
    )
  ) {
    transitionInvalid("event hashes conflict with accepted projection");
  }

  if (event.event_type === "OWNER_QUESTION_ACCEPTED") {
    transitionInvalid("owner question is already accepted");
  }
  if (projection.current_state === "DELIVERED") {
    transitionInvalid("delivered coordination is immutable");
  }
  if (
    projection.current_state === "READY_FOR_DELIVERY" &&
    event.event_type !== "WORKER_5_DELIVERY_ACKNOWLEDGED"
  ) {
    transitionInvalid("closed coordination accepts only delivery acknowledgment");
  }

  const assignment = event.assignment_id === null
    ? null
    : assignments.find((candidate) => candidate.assignment_id === event.assignment_id) ?? null;
  if (event.event_type === "HEAD_CHEF_ASSIGNMENT_CREATED") {
    if (assignment) transitionInvalid("assignment_id is already present");
    return { replayed: false, transition: event.event_type };
  }
  if (event.assignment_id !== null) {
    if (!assignment) transitionPending("assignment has not reached the Control Room");
    if (
      assignment.target_worker_id !== event.target_worker_id ||
      assignment.target_workstream_id !== event.target_workstream_id
    ) {
      transitionInvalid("assignment worker/workstream binding differs");
    }
    if (assignment.terminal_event_id !== null) {
      transitionInvalid("assignment already has a terminal result");
    }
    if (
      event.coordination_id === CONDITION4_COORDINATION_ID &&
      CONDITION4_RESEARCH_EVENT_TYPES.has(event.event_type) &&
      (assignment.priority !== "HIGH" ||
        assignment.decision_class !== CONDITION4_DECISION_CLASS ||
        assignment.requested_decision !== CONDITION4_REQUESTED_DECISION ||
        assignment.source_record_ids.length !== 1 ||
        assignment.source_record_ids[0] !== CONDITION4_SOURCE_RECORD_ID ||
        assignment.dependencies.length !== 0)
    ) {
      transitionInvalid("Condition 4 event is not bound to the exact assignment");
    }
  }

  if (event.event_type === "HEAD_CHEF_ASSIGNMENT_ACKNOWLEDGED") {
    if (assignment.acknowledged) transitionInvalid("assignment is already acknowledged");
  }
  if (
    [
      "SPECIALIST_RESULT_POSTED",
      "HEAD_CHEF_FOLLOW_UP_REQUESTED",
      "SPECIALIST_PUBLICATION_REQUESTED",
      "SPECIALIST_NO_CHANGE_ACCEPTED",
      "SPECIALIST_EVIDENCE_BLOCKED",
    ].includes(event.event_type) &&
    !assignment.acknowledged
  ) {
    transitionPending("assignment acknowledgment has not reached the Control Room");
  }
  const assignmentHistory = event.assignment_id === null
    ? []
    : events.filter((record) => record.event.assignment_id === event.assignment_id);
  const lastFollowUpIndex = assignmentHistory.findLastIndex(
    (record) => record.event_type === "HEAD_CHEF_FOLLOW_UP_REQUESTED",
  );
  const currentReviewResults = assignmentHistory
    .slice(lastFollowUpIndex + 1)
    .filter((record) => record.event_type === "SPECIALIST_RESULT_POSTED");
  if (
    event.event_type === "SPECIALIST_RESULT_POSTED" &&
    currentReviewResults.length > 0
  ) {
    transitionInvalid("review cycle already has a specialist result");
  }
  if (event.event_type === "HEAD_CHEF_FOLLOW_UP_REQUESTED") {
    if (!assignmentHistory.some((record) => record.event_type === "SPECIALIST_RESULT_POSTED")) {
      transitionPending("follow-up requires a prior specialist result");
    }
  }
  if (
    event.coordination_id === CONDITION4_COORDINATION_ID &&
    [
      "SPECIALIST_PUBLICATION_REQUESTED",
      "SPECIALIST_NO_CHANGE_ACCEPTED",
      "SPECIALIST_EVIDENCE_BLOCKED",
    ].includes(event.event_type)
  ) {
    if (currentReviewResults.length !== 1) {
      transitionPending("Condition 4 terminal transition requires exactly one current specialist result");
    }
    const result = currentReviewResults[0].event;
    if (
      result.decision_class !== event.decision_class ||
      canonicalJson(result.source_record_ids) !== canonicalJson(event.source_record_ids) ||
      canonicalJson(result.dependencies) !== canonicalJson(event.dependencies) ||
      result.summary !== event.summary
    ) {
      transitionInvalid("Condition 4 terminal transition conflicts with the specialist result");
    }
  }
  if (
    event.event_type === "HEAD_CHEF_FOLLOW_UP_REQUESTED" &&
    assignment.follow_up_count >= 3
  ) {
    transitionInvalid("specialist follow-up limit reached");
  }
  if (
    event.event_type === "SPECIALIST_PUBLICATION_REQUESTED" &&
    assignment.publication_requested
  ) {
    transitionInvalid("assignment already has a publication request");
  }
  if (
    event.event_type === "SPECIALIST_PUBLICATION_ACCEPTED" &&
    !assignment.publication_requested
  ) {
    transitionPending("publication request has not reached the Control Room");
  }
  if (
    event.coordination_id === CONDITION4_COORDINATION_ID &&
    event.event_type === "SPECIALIST_PUBLICATION_ACCEPTED"
  ) {
    const currentPublicationRequests = assignmentHistory
      .slice(lastFollowUpIndex + 1)
      .filter((record) => record.event_type === "SPECIALIST_PUBLICATION_REQUESTED");
    if (currentReviewResults.length !== 1 || currentPublicationRequests.length !== 1) {
      transitionPending("Condition 4 publication acceptance requires one material result and request");
    }
    const result = currentReviewResults[0].event;
    const request = currentPublicationRequests[0].event;
    if (
      result.decision_class !== "MATERIAL_IMPORT_PUBLICATION_REQUIRED" ||
      request.decision_class !== result.decision_class ||
      canonicalJson(request.source_record_ids) !== canonicalJson(result.source_record_ids) ||
      canonicalJson(request.dependencies) !== canonicalJson(result.dependencies) ||
      request.summary !== result.summary
    ) {
      transitionInvalid("Condition 4 publication chain conflicts with the specialist result");
    }
  }
  if (event.event_type === "HEAD_CHEF_CLOSURE_CREATED") {
    const ownerGatePresent = events.some((record) => record.event_type === "OWNER_GATE_REQUIRED");
    if (ownerGatePresent) transitionInvalid("an unresolved owner gate prevents closure");
    const reviewOnlyClosure =
      assignments.length === 0 &&
      events.some((record) => record.event_type === "HEAD_CHEF_REVIEW_REQUEST");
    const assignmentsTerminal =
      assignments.length > 0 &&
      assignments.every((candidate) => candidate.terminal_event_id !== null);
    if (!reviewOnlyClosure && !assignmentsTerminal) {
      transitionPending("coordination is not ready for closure");
    }
  }
  if (
    event.event_type === "WORKER_5_DELIVERY_ACKNOWLEDGED" &&
    projection.current_state !== "READY_FOR_DELIVERY"
  ) {
    transitionPending("Head Chef closure has not reached the Control Room");
  }
  return { replayed: false, transition: event.event_type };
}

async function fetchTransitionProjection(context, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(transitionProjectionUrl(context.document.coordination_id), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-store",
        "User-Agent": "pulsechain-head-chef-coordination-ingest",
      },
    });
  } catch {
    fail("CONTROL_ROOM_TRANSITION_PROJECTION_UNAVAILABLE");
  }
  if (response?.status === 404) {
    const value = await boundedJsonResponse(response, "CONTROL_ROOM_PROJECTION", MAX_CONTROL_ROOM_RESPONSE_BYTES);
    if (!plainObject(value) || value.error !== "HEAD_CHEF_COORDINATION_NOT_FOUND") {
      fail("CONTROL_ROOM_TRANSITION_PROJECTION_INVALID", "unexpected not-found response");
    }
    return null;
  }
  if (!response?.ok || response.status !== 200) {
    fail("CONTROL_ROOM_TRANSITION_PROJECTION_FAILED", `HTTP_${response?.status ?? "UNKNOWN"}`);
  }
  return boundedJsonResponse(response, "CONTROL_ROOM_PROJECTION", MAX_CONTROL_ROOM_RESPONSE_BYTES);
}

export async function preflightTransitionProjection(
  context,
  fetchImpl = globalThis.fetch,
  waitImpl = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const projection = await fetchTransitionProjection(context, fetchImpl);
      return validateTransitionProjection(context.document, projection, {
        sourceIssueNumber: context.issue.number,
      });
    } catch (error) {
      const prerequisitePending =
        error instanceof HeadChefCoordinationIngestError &&
        error.code === "CONTROL_ROOM_TRANSITION_PREREQUISITE_PENDING" &&
        error.mayHaveCommitted === false;
      if (!prerequisitePending || attempt >= PROJECTION_RETRY_DELAYS_MS.length) throw error;
      await waitImpl(PROJECTION_RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function fetchGitHubObject(path, githubToken, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pulsechain-head-chef-coordination-ingest",
      },
    });
  } catch {
    fail("GITHUB_SOURCE_READBACK_UNAVAILABLE");
  }
  if (!response?.ok || response.status !== 200) fail("GITHUB_SOURCE_READBACK_FAILED", `HTTP_${response?.status ?? "UNKNOWN"}`);
  const value = await boundedJsonResponse(response, "GITHUB", MAX_GITHUB_RESPONSE_BYTES);
  if (!plainObject(value)) fail("GITHUB_SOURCE_RESPONSE_INVALID");
  return value;
}

export async function refetchAndValidateGitHubSource(context, githubToken, fetchImpl = globalThis.fetch) {
  const liveIssue = await fetchGitHubObject(`issues/${context.issue.number}`, githubToken, fetchImpl);
  validateIssueIdentity(liveIssue);
  if (
    liveIssue.number !== context.issue.number ||
    liveIssue.node_id !== context.issue.node_id ||
    liveIssue.title !== context.issue.title ||
    liveIssue.body !== context.issue.body ||
    liveIssue.created_at !== context.issue.created_at
  ) {
    fail("GITHUB_ISSUE_READBACK_MISMATCH");
  }
  let liveBody = liveIssue.body;
  let liveComment = null;
  if (context.eventName === "issue_comment") {
    liveComment = await fetchGitHubObject(`issues/comments/${context.comment.id}`, githubToken, fetchImpl);
    validateCommentIdentity(liveComment, liveIssue);
    if (
      liveComment.id !== context.comment.id ||
      liveComment.node_id !== context.comment.node_id ||
      liveComment.html_url !== context.comment.html_url ||
      liveComment.body !== context.comment.body ||
      liveComment.created_at !== context.comment.created_at
    ) {
      fail("GITHUB_COMMENT_READBACK_MISMATCH");
    }
    liveBody = liveComment.body;
  }
  if (liveBody !== context.body) fail("GITHUB_BODY_READBACK_MISMATCH");
  const document = parseEventBody(liveBody, { sourceKind: context.sourceKind });
  if (!document || canonicalJson(document) !== canonicalJson(context.document)) {
    fail("GITHUB_EVENT_DOCUMENT_READBACK_MISMATCH");
  }
  const sourceCreatedAt = githubTimestamp(
    context.eventName === "issues" ? liveIssue.created_at : liveComment.created_at,
    "source.created_at",
  );
  const eventCreatedAt = Date.parse(document.created_at_utc);
  const sourcePrecisionAllowance = 999;
  if (
    eventCreatedAt - sourceCreatedAt > sourcePrecisionAllowance ||
    sourceCreatedAt - eventCreatedAt > 10 * 60 * 1_000
  ) {
    fail("GITHUB_SOURCE_TIME_MISMATCH");
  }
  return { liveIssue, liveComment, document };
}

export function buildTransportEnvelope(context, document = context.document) {
  const source = {
    repository: REPOSITORY,
    repository_id: REPOSITORY_ID,
    repository_owner_id: REPOSITORY_OWNER_ID,
    actor: AUTHORIZED_ACTOR,
    actor_id: AUTHORIZED_ACTOR_ID,
    issue_number: context.issue.number,
    issue_node_id: context.issue.node_id,
    issue_title: context.issue.title,
    issue_url: context.issue.html_url,
    comment_id: context.comment?.id ?? null,
    comment_node_id: context.comment?.node_id ?? null,
    comment_url: context.comment?.html_url ?? null,
    event_name: context.eventName,
    event_action: context.eventName === "issues" ? "opened" : "created",
    ref: REF,
    workflow_ref: context.runtime.expectedWorkflowRef,
    workflow_sha: context.runtime.workflowSha,
    run_id: context.runtime.runId,
    run_attempt: context.runtime.runAttempt,
    body_sha256: sha256(Buffer.from(canonicalJson(document), "utf8")),
  };
  exactKeys(source, SOURCE_FIELDS, "source");
  if (!COMMIT.test(source.workflow_sha || "")) fail("INVALID_WORKFLOW_SHA");
  return { event: document, source };
}

export function oidcRequestUrl(baseUrl) {
  const text = safeText(baseUrl, "ACTIONS_ID_TOKEN_REQUEST_URL", 4_096);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail("INVALID_OIDC_REQUEST_URL");
  }
  if (url.protocol !== "https:" || url.searchParams.has("audience")) fail("INVALID_OIDC_REQUEST_URL");
  const separator = text.includes("?") ? "&" : "?";
  return `${text}${separator}audience=${encodeURIComponent(ENDPOINT)}`;
}

async function requestOidcToken(env, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(oidcRequestUrl(required(env, "ACTIONS_ID_TOKEN_REQUEST_URL")), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${required(env, "ACTIONS_ID_TOKEN_REQUEST_TOKEN")}` },
    });
  } catch {
    fail("OIDC_TOKEN_REQUEST_UNAVAILABLE");
  }
  if (!response?.ok || response.status !== 200) fail("OIDC_TOKEN_REQUEST_FAILED", `HTTP_${response?.status ?? "UNKNOWN"}`);
  const value = await boundedJsonResponse(response, "OIDC", 32 * 1024);
  if (!plainObject(value) || typeof value.value !== "string" || value.value.length < 32 || value.value.length > 20_000) {
    fail("OIDC_TOKEN_RESPONSE_INVALID");
  }
  return value.value;
}

export function validateAcceptedReceipt(value, transport) {
  exactKeys(value, RECEIPT_FIELDS, "receipt");
  if (value.schema_version !== RECEIPT_SCHEMA || value.accepted !== true || typeof value.replayed !== "boolean") {
    fail("CONTROL_ROOM_RECEIPT_INVALID");
  }
  if (
    value.coordination_id !== transport.event.coordination_id ||
    value.event_id !== transport.event.event_id ||
    value.canonical_duplicate_key !== transport.event.canonical_duplicate_key ||
    value.content_sha256 !== transport.event.content_sha256 ||
    value.source_issue_number !== transport.source.issue_number ||
    value.source_comment_id !== transport.source.comment_id ||
    value.run_id !== transport.source.run_id ||
    value.run_attempt !== transport.source.run_attempt
  ) {
    fail("CONTROL_ROOM_RECEIPT_PROVENANCE_MISMATCH");
  }
  if (!SHA256.test(value.canonical_duplicate_key) || !SHA256.test(value.content_sha256)) {
    fail("CONTROL_ROOM_RECEIPT_HASH_INVALID");
  }
  return value;
}

function validatedRejectionCode(value) {
  if (!plainObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== REJECTION_FIELDS.length ||
    keys.some((key, index) => key !== REJECTION_FIELDS[index]) ||
    value.schema_version !== REJECTION_SCHEMA ||
    value.accepted !== false ||
    typeof value.error !== "string" ||
    !/^[A-Z][A-Z0-9_]{2,119}$/.test(value.error)
  ) {
    return null;
  }
  return value.error;
}

async function postToControlRoom(transport, oidcToken, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json",
      },
      body: canonicalJson(transport),
    });
  } catch {
    fail("CONTROL_ROOM_RESPONSE_UNCERTAIN", "request outcome is unknown", { mayHaveCommitted: true });
  }
  let value;
  try {
    value = await boundedJsonResponse(response, "CONTROL_ROOM", MAX_CONTROL_ROOM_RESPONSE_BYTES);
  } catch (error) {
    if (response?.ok || response?.status >= 500 || !response) {
      fail("CONTROL_ROOM_RESPONSE_UNCERTAIN", "response could not be authenticated", { mayHaveCommitted: true });
    }
    throw error;
  }
  if (response?.ok && ![200, 201].includes(response.status)) {
    fail(`CONTROL_ROOM_HTTP_${response.status}`, "unsupported success status", {
      mayHaveCommitted: true,
    });
  }
  if (!response?.ok) {
    const code = validatedRejectionCode(value) ??
      `HTTP_${response?.status ?? "UNKNOWN"}`;
    if (response?.status >= 500) fail(`CONTROL_ROOM_${code}`, "", { mayHaveCommitted: true });
    fail(`CONTROL_ROOM_${code}`);
  }
  try {
    const receipt = validateAcceptedReceipt(value, transport);
    if (
      (response.status === 201 && receipt.replayed !== false) ||
      (response.status === 200 && receipt.replayed !== true)
    ) {
      fail("CONTROL_ROOM_RECEIPT_STATUS_MISMATCH");
    }
    return receipt;
  } catch (error) {
    const code = error instanceof HeadChefCoordinationIngestError
      ? error.code
      : "CONTROL_ROOM_RECEIPT_INVALID";
    fail(code, "accepted response receipt is invalid", { mayHaveCommitted: true });
  }
}

export function formatReceiptComment(receipt) {
  exactKeys(receipt, RECEIPT_FIELDS, "receipt");
  const comment = `${RECEIPT_MARKER}\n${canonicalJson(receipt)}`;
  if (Buffer.byteLength(comment, "utf8") > 8_192 || SECRET_PATTERN.test(comment)) fail("RECEIPT_COMMENT_INVALID");
  return comment;
}

async function postReceiptComment(issueNumber, receipt, githubToken, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/issues/${issueNumber}/comments`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${githubToken}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pulsechain-head-chef-coordination-ingest",
      },
      body: JSON.stringify({ body: formatReceiptComment(receipt) }),
    });
  } catch {
    fail("MACHINE_RECEIPT_COMMENT_FAILED", "request outcome is unknown", { mayHaveCommitted: true });
  }
  if (!response?.ok || response.status !== 201) {
    fail("MACHINE_RECEIPT_COMMENT_FAILED", `HTTP_${response?.status ?? "UNKNOWN"}`, { mayHaveCommitted: true });
  }
}

export async function processGitHubEvent({
  event,
  env = process.env,
  fetchImpl = globalThis.fetch,
  waitImpl = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  const ignored = ignoredEventReason(event, env);
  if (ignored) return { ignored: true, reason: ignored };
  const githubToken = required(env, "GITHUB_TOKEN");
  if (githubToken.length < 20 || githubToken.length > 4_096 || /\s|\0/.test(githubToken)) fail("GITHUB_TOKEN_INVALID");
  const context = validateGitHubEvent(event, env);
  if (!context) return { ignored: true, reason: "MACHINE_RECEIPT" };
  await refetchAndValidateGitHubSource(context, githubToken, fetchImpl);
  const transport = buildTransportEnvelope(context);
  await preflightTransitionProjection(context, fetchImpl, waitImpl);
  const oidcToken = await requestOidcToken(env, fetchImpl);
  let receipt;
  for (let attempt = 0; ; attempt += 1) {
    try {
      receipt = await postToControlRoom(transport, oidcToken, fetchImpl);
      break;
    } catch (error) {
      const transitionPending =
        error instanceof HeadChefCoordinationIngestError &&
        TRANSITION_RETRY_CODES.has(error.code) &&
        error.mayHaveCommitted === false;
      if (!transitionPending || attempt >= TRANSITION_RETRY_DELAYS_MS.length) throw error;
      await waitImpl(TRANSITION_RETRY_DELAYS_MS[attempt]);
    }
  }
  await postReceiptComment(context.issue.number, receipt, githubToken, fetchImpl);
  return { ignored: false, receipt };
}

async function main() {
  const event = JSON.parse(await readFile(required(process.env, "GITHUB_EVENT_PATH"), "utf8"));
  const result = await processGitHubEvent({ event });
  process.stdout.write(`${canonicalJson(result)}\n`);
}

const invokedPath = process.argv[1]
  ? fileURLToPath(new URL(import.meta.url)) === resolve(process.argv[1])
  : false;
if (invokedPath) {
  main().catch((error) => {
    const known = error instanceof HeadChefCoordinationIngestError;
    process.stderr.write(`${known ? error.code : "HEAD_CHEF_COORDINATION_INGEST_FAILED"}\n`);
    process.exitCode = 1;
  });
}

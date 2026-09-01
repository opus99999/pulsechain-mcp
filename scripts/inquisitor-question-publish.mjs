#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const ACTION = "CREATE_INQUISITOR_QUESTION";
const SCHEMA = "pulsechain-inquisitor-question-request@1.0.0";
const LABEL = "pulsechain-inquisitor-question";
const TITLE = "[pulsechain-inquisitor-question] CREATE_INQUISITOR_QUESTION";
const OWNER = "opus99999";
const OWNER_ID = "212180323";
const REPOSITORY = "opus99999/pulsechain-mcp";
const REPOSITORY_ID = "1320639709";
const RECOVERY_ISSUE = 30;
const ORIGIN = "https://pulsechain-research-control-room.brohexphiat.chatgpt.site";
const ENDPOINT = `${ORIGIN}/api/v1/inquisitor/questions/github`;
const QUESTION_QUEUE = `${ORIGIN}/api/v1/inquisitor/questions`;
const EXPECTED_KEYS = [
  "schema_version", "action", "priority", "question", "why_material", "current_evidence_summary",
  "required_cutoff", "required_sources", "prohibited_inferences", "required_output",
  "grok_x_protocol_task", "grok_infrastructure_incidents_task", "grok_market_liquidity_task",
  "grok_identity_evidence_task", "grok_red_team_task", "specialist_review_targets",
  "expires_at_utc", "public_safe",
].sort();

function fail(message) { throw new Error(message); }
function required(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}
function exactObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Issue body must be one JSON object");
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(EXPECTED_KEYS)) fail("Issue body fields are not exact");
  if (value.schema_version !== SCHEMA || value.action !== ACTION || value.public_safe !== true) {
    fail("Issue body is not the Inquisitor question schema");
  }
  return value;
}
function normalizedText(value, name) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail(`${name} is invalid`);
  return value.trim();
}
function normalizedList(value, name) {
  if (!Array.isArray(value) || !value.length || value.length > 20) fail(`${name} is invalid`);
  const rows = value.map((item) => normalizedText(item, name));
  if (rows.some((item) => item.length > 500) || new Set(rows).size !== rows.length) fail(`${name} is invalid`);
  return rows;
}
function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("Question content is not canonical");
}
function duplicateKey(question) {
  const assignments = {
    "grok-x-protocol": normalizedText(question.grok_x_protocol_task, "grok_x_protocol_task"),
    "grok-infrastructure-incidents": normalizedText(question.grok_infrastructure_incidents_task, "grok_infrastructure_incidents_task"),
    "grok-market-liquidity": normalizedText(question.grok_market_liquidity_task, "grok_market_liquidity_task"),
    "grok-identity-evidence": normalizedText(question.grok_identity_evidence_task, "grok_identity_evidence_task"),
    "grok-red-team": normalizedText(question.grok_red_team_task, "grok_red_team_task"),
  };
  const value = {
    priority: normalizedText(question.priority, "priority"),
    question: normalizedText(question.question, "question"),
    why_material: normalizedText(question.why_material, "why_material"),
    current_evidence_summary: normalizedText(question.current_evidence_summary, "current_evidence_summary"),
    required_cutoff: normalizedText(question.required_cutoff, "required_cutoff"),
    required_sources: normalizedList(question.required_sources, "required_sources"),
    prohibited_inferences: normalizedList(question.prohibited_inferences, "prohibited_inferences"),
    required_output: normalizedText(question.required_output, "required_output"),
    assignments,
    specialist_review_targets: normalizedList(question.specialist_review_targets, "specialist_review_targets"),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}
async function jsonResponse(response, label) {
  if (!response.ok) fail(`${label} failed with HTTP ${response.status}`);
  try { return await response.json(); } catch { fail(`${label} returned invalid JSON`); }
}
async function preflightRecovery(question, event) {
  const token = required("GITHUB_TOKEN");
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
  const comments = await jsonResponse(await fetch(
    `https://api.github.com/repos/${REPOSITORY}/issues/${RECOVERY_ISSUE}/comments?per_page=100`,
    { headers },
  ), "Issue receipt preflight");
  if (!Array.isArray(comments)) fail("Issue receipt preflight returned invalid data");
  if (comments.some((comment) => typeof comment?.body === "string" && /^INQUISITOR_QUESTION_ACCEPTED(?:\r?\n|$)/.test(comment.body))) {
    fail("Issue 30 already has an accepted machine receipt");
  }
  const queue = await jsonResponse(await fetch(QUESTION_QUEUE, {
    headers: { accept: "application/json", "cache-control": "no-store" },
  }), "Question queue preflight");
  if (!queue || !Array.isArray(queue.questions)) fail("Question queue preflight returned invalid data");
  if (queue.questions.some((item) => Number(item?.source_issue_number) === RECOVERY_ISSUE)) {
    fail("Issue 30 already has a Hitter Board question");
  }
  const key = duplicateKey(question);
  const now = Date.now();
  if (queue.questions.some((item) => item?.canonical_duplicate_key === key && Date.parse(item?.expires_at_utc) > now)) {
    fail("Issue 30 has an active canonical duplicate");
  }
  if (event.issue.number !== RECOVERY_ISSUE) fail("Recovery issue identity changed");
}

const event = JSON.parse(await readFile(required("GITHUB_EVENT_PATH"), "utf8"));
const opened = event.action === "opened";
const recovery = event.action === "reopened" && event.issue?.number === RECOVERY_ISSUE;
if ((!opened && !recovery) || event.repository?.full_name !== REPOSITORY ||
    String(event.repository?.id) !== REPOSITORY_ID || event.sender?.login !== OWNER ||
    String(event.sender?.id) !== OWNER_ID || event.issue?.user?.login !== OWNER ||
    String(event.issue?.user?.id) !== OWNER_ID || event.issue?.state !== "open" ||
    event.issue?.title !== TITLE || !Number.isSafeInteger(event.issue?.number) ||
    !/^I_[A-Za-z0-9_-]{8,160}$/.test(event.issue?.node_id ?? "") ||
    event.issue?.html_url !== `https://github.com/${REPOSITORY}/issues/${event.issue?.number}`) {
  fail("Issue event is outside the Inquisitor question publication scope");
}
if (typeof event.issue?.body !== "string" || Buffer.byteLength(event.issue.body, "utf8") > 80_000) {
  fail("Issue body is missing or too large");
}
let question;
try { question = exactObject(JSON.parse(event.issue.body)); } catch (error) {
  fail(`Question schema rejected: ${error instanceof Error ? error.message : "invalid JSON"}`);
}
const expires = Date.parse(question.expires_at_utc);
if (typeof question.expires_at_utc !== "string" || !question.expires_at_utc.endsWith("Z") ||
    Number.isNaN(expires) || expires <= Date.now()) {
  fail("Issue question has expired");
}
if (recovery) await preflightRecovery(question, event);

const tokenResponse = await fetch(
  `${required("ACTIONS_ID_TOKEN_REQUEST_URL")}&audience=${encodeURIComponent(ENDPOINT)}`,
  { headers: { authorization: `Bearer ${required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}` } },
);
if (!tokenResponse.ok) fail(`GitHub OIDC token request failed with HTTP ${tokenResponse.status}`);
const oidc = await tokenResponse.json();
if (typeof oidc.value !== "string" || !oidc.value) fail("GitHub OIDC token response is invalid");

const document = {
  ...question,
  source_issue: {
    repository: event.repository.full_name,
    repository_id: String(event.repository.id),
    issue_number: event.issue.number,
    issue_node_id: event.issue.node_id,
    issue_url: event.issue.html_url,
    event_class: LABEL,
    author_id: String(event.issue.user.id),
  },
};
const response = await fetch(ENDPOINT, {
  method: "POST",
  headers: { authorization: `Bearer ${oidc.value}`, "content-type": "application/json" },
  body: JSON.stringify(document),
});
const responseText = await response.text();
let receipt;
try { receipt = JSON.parse(responseText); } catch { fail(`Control Room returned non-JSON HTTP ${response.status}`); }
if (!response.ok || receipt.accepted !== true || typeof receipt.question_id !== "string") {
  fail(`Control Room rejected question: ${receipt.error_code ?? `HTTP_${response.status}`}`);
}

const comment = [
  "INQUISITOR_QUESTION_ACCEPTED",
  "",
  "```json",
  JSON.stringify(receipt, null, 2),
  "```",
].join("\n");
const commentResponse = await fetch(
  `https://api.github.com/repos/${REPOSITORY}/issues/${event.issue.number}/comments`,
  {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${required("GITHUB_TOKEN")}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ body: comment }),
  },
);
if (!commentResponse.ok) fail(`Machine receipt comment failed with HTTP ${commentResponse.status}`);
process.stdout.write(`${JSON.stringify({ accepted: true, question_id: receipt.question_id })}\n`);

#!/usr/bin/env node

// Source-only integration harness. The Control Room build task that created this
// file did not execute it. A later verifier may run it with Node 22 and Git.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AUTHORIZED_ACTOR,
  AUTHORIZED_ACTOR_ID,
  INDEX_SCHEMA,
  LATEST_SCHEMA,
  MANIFEST_SCHEMA,
  PROJECT_ID,
  REPOSITORY,
  REQUEST_SCHEMA,
  WORKSTREAMS,
  canonicalJson,
  emptyIndex,
  emptyLatest,
  jsonBytes,
  publishToLedger,
  validatePublicationRequest,
} from "../scripts/trusted-team-publish.mjs";

function command(program, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${program} exited ${code}`));
    });
  });
}

async function git(cwd, ...args) {
  return command("git", args, cwd);
}

async function write(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function digest(label) {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

class ExactBarrier {
  constructor(expectedIds) {
    this.expectedIds = new Set(expectedIds);
    this.arrived = new Set();
    this.released = false;
    this.waiter = new Promise((resolve) => { this.release = resolve; });
  }

  async arrive(id) {
    assert.equal(this.released, false, "no first-attempt participant may arrive after release");
    assert.equal(this.expectedIds.has(id), true, `unexpected barrier participant ${id}`);
    assert.equal(this.arrived.has(id), false, `duplicate barrier participant ${id}`);
    this.arrived.add(id);
    if (this.arrived.size === this.expectedIds.size) {
      assert.deepEqual([...this.arrived].sort(), [...this.expectedIds].sort());
      this.released = true;
      this.release();
    }
    await this.waiter;
  }
}

function requestFor(workstream, position, expectedHead) {
  const updateId = `canary-${workstream}-20260825-${position + 1}`;
  return validatePublicationRequest({
    schema_version: REQUEST_SCHEMA,
    project_id: PROJECT_ID,
    workstream_id: workstream,
    update_id: updateId,
    expected_repository_head: expectedHead,
    expected_latest_update_id: null,
    title: `Synthetic trusted-team canary for ${workstream}`,
    status: "CANARY_COMPLETE",
    classification: "TRUSTED_TEAM_CANARY",
    current_task: `Verify concurrent publication for ${workstream}`,
    dependencies: WORKSTREAMS.filter((candidate) => candidate !== workstream).map((candidate) => `${candidate}:readable`),
    summary_markdown: `Synthetic summary for ${workstream}.`,
    final_response_markdown: `Synthetic final response for ${workstream}. No research findings are present.`,
    project_state_summary: `The ${workstream} synthetic publication completed.`,
    next_work_handoff_markdown: `Read the other three synthetic updates, then stop.`,
    visibility: position === 0 ? "PUBLIC" : position === 2 ? "PRIVATE" : "WORKSPACE",
    artifact: {
      filename: `PulseChain_${workstream.replaceAll("-", "_")}_Trusted_Team_Canary_20260825T23000${position}Z.zip`,
      byte_size: 1024 + position,
      sha256: digest(`artifact:${workstream}`),
      member_count: 4 + position,
      generated_at: `2026-08-25T23:00:0${position}.000Z`,
      workstream_id: workstream,
      update_id: updateId,
      library_folder: `PulseChain_Control_Room/${workstream}/`,
      visibility: position === 0 ? "PUBLIC" : position === 2 ? "PRIVATE" : "WORKSPACE",
      upload_status: "UPLOADED",
    },
    public_metadata_attestation: {
      public_metadata_approved: true,
      contains_secrets: false,
      contains_hidden_reasoning: false,
      contains_private_contact_information: false,
      contains_raw_restricted_material: false,
      synthetic_canary: true,
    },
  }, workstream);
}

function contextFor(request, position, workflowSha) {
  return {
    request,
    published_at: `2026-08-25T23:01:0${position}.000Z`,
    issue_number: 100 + position,
    issue_url: `https://github.com/${REPOSITORY}/issues/${100 + position}`,
    workflow_ref: `${REPOSITORY}/.github/workflows/trusted-team-${request.workstream_id}.yml@refs/heads/main`,
    workflow_sha: workflowSha,
    actor: AUTHORIZED_ACTOR,
    actor_id: AUTHORIZED_ACTOR_ID,
  };
}

async function seedRepository(root) {
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  await git(root, "init", "--bare", remote);
  await mkdir(seed);
  await git(seed, "init", "-b", "main");
  for (const workstream of WORKSTREAMS) {
    await write(join(seed, "workstreams", workstream, "latest.json"), jsonBytes(emptyLatest(workstream)));
    await write(join(seed, "workstreams", workstream, "index.json"), jsonBytes(emptyIndex(workstream)));
  }
  await git(seed, "add", "workstreams");
  await git(seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Initialize empty trusted-team ledger");
  const head = await git(seed, "rev-parse", "HEAD");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-u", "origin", "main");
  await git(root, `--git-dir=${remote}`, "symbolic-ref", "HEAD", "refs/heads/main");
  return { remote, head };
}

async function cloneWorker(root, remote, workstream) {
  const path = join(root, `worker-${workstream}`);
  await git(root, "clone", remote, path);
  return path;
}

async function verifyWorkerCanReadAll(worker, requests) {
  await git(worker, "fetch", "origin", "main");
  await git(worker, "reset", "--hard", "origin/main");
  for (const request of requests) {
    const prefix = join(worker, "workstreams", request.workstream_id);
    const latest = JSON.parse(await readFile(join(prefix, "latest.json"), "utf8"));
    const index = JSON.parse(await readFile(join(prefix, "index.json"), "utf8"));
    const update = join(prefix, "updates", request.update_id);
    assert.equal(latest.schema_version, LATEST_SCHEMA);
    assert.equal(latest.update_id, request.update_id);
    assert.equal(index.schema_version, INDEX_SCHEMA);
    assert.equal(index.updates.length, 1);
    assert.equal(index.updates[0].update_id, request.update_id);
    const names = ["summary.md", "project_state.json", "next_work_handoff.md", "manifest.json"];
    for (const name of names) await readFile(join(update, name));
    const manifest = JSON.parse(await readFile(join(update, "manifest.json"), "utf8"));
    assert.equal(manifest.schema_version, MANIFEST_SCHEMA);
    assert.equal(manifest.workstream_id, request.workstream_id);
    assert.equal(manifest.update_id, request.update_id);
    assert.equal(manifest.artifact.filename, request.artifact.filename);
    assert.equal(manifest.artifact.sha256, request.artifact.sha256);
    assert.deepEqual(manifest.files.map((file) => file.filename), [
      "summary.md",
      "project_state.json",
      "next_work_handoff.md",
    ]);
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "trusted-team-ledger-"));
  const { remote, head } = await seedRepository(root);
  const requests = WORKSTREAMS.map((workstream, position) => requestFor(workstream, position, head));
  const clones = await Promise.all(WORKSTREAMS.map((workstream) => cloneWorker(root, remote, workstream)));
  const barrier = new ExactBarrier(requests.map((request) => request.update_id));

  const results = await Promise.all(requests.map((request, position) => publishToLedger({
    repositoryRoot: clones[position],
    request,
    context: contextFor(request, position, head),
    hooks: {
      beforePush: async ({ attempt }) => {
        if (attempt === 1) await barrier.arrive(request.update_id);
      },
    },
  })));

  assert.equal(results.length, 4);
  assert.equal(results.every((result) => result.result === "ACCEPTED"), true);
  assert.equal(new Set(results.map((result) => result.commit)).size, 4);
  assert.equal(results.some((result) => result.attempts > 1), true, "the forced first-attempt race must exercise bounded retry");
  assert.equal(Math.max(...results.map((result) => result.attempts)) <= 4, true);

  for (const clone of clones) await verifyWorkerCanReadAll(clone, requests);

  const reader = clones[0];
  const history = await git(reader, "rev-list", "--reverse", "origin/main");
  assert.equal(history.split("\n").length, 5, "one seed plus four append-only publication commits expected");
  assert.equal(new Set(requests.map((request) => request.artifact.filename)).size, 4);
  assert.equal(new Set(requests.map((request) => request.artifact.sha256)).size, 4);
  assert.equal(barrier.released, true);
  assert.deepEqual([...barrier.arrived].sort(), requests.map((request) => request.update_id).sort());

  process.stdout.write(`${canonicalJson({ result: "PASS", results })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ result: "FAIL", error: String(error.message || error) })}\n`);
  process.exitCode = 1;
});

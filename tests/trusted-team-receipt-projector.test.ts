import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  HISTORICAL_PROOFS,
  projectTrustedTeamReceipt,
} from "../scripts/trusted-team-receipt-projector.mjs";

const prior = { ...process.env };
const realFetch = globalThis.fetch;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function receipt(expected: (typeof HISTORICAL_PROOFS)[number]) {
  return {
    schema_version: "pulsechain-trusted-team-publication-receipt@1.0.0",
    result: "ACCEPTED",
    repository: "opus99999/pulsechain-mcp",
    workstream_id: expected.workstream_id,
    update_id: expected.update_id,
    update_path: `workstreams/${expected.workstream_id}/updates/${expected.update_id}`,
    permanent_update_url: `https://pulsechain-research-control-room.brohexphiat.chatgpt.site/research/workstreams/${expected.workstream_id}/updates/${expected.update_id}`,
    commit: expected.publication_commit,
    parent_commit: expected.parent_commit,
    initial_repository_head: expected.parent_commit,
    first_observed_repository_head: expected.parent_commit,
    observed_repository_head: expected.publication_commit,
    manifest_sha256: expected.manifest_sha256,
    artifact_filename: expected.artifact_filename,
    artifact_sha256: expected.artifact_sha256,
    attempts: 1,
    retries: 0,
    issue_number: expected.issue_number,
  };
}

function comment(expected: (typeof HISTORICAL_PROOFS)[number], change: Record<string, unknown> = {}) {
  const body = { ...receipt(expected), ...change };
  return {
    id: expected.receipt_comment_id,
    issue_url: `https://api.github.com/repos/opus99999/pulsechain-mcp/issues/${expected.issue_number}`,
    user: { login: "github-actions[bot]", id: 41898282 },
    author_association: "NONE",
    performed_via_github_app: { id: 15368, slug: "github-actions" },
    body: `\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``,
  };
}

async function githubResponse(url: string, expected: (typeof HISTORICAL_PROOFS)[number], changedReceipt: Record<string, unknown> = {}) {
  if (url.endsWith(`/issues/comments/${expected.receipt_comment_id}`)) return json(comment(expected, changedReceipt));
  if (url.endsWith(`/git/commits/${expected.publication_commit}`)) {
    return json({ sha: expected.publication_commit, tree: { sha: "f".repeat(40) }, parents: [{ sha: expected.parent_commit }] });
  }
  const marker = "/contents/";
  if (url.includes(marker)) {
    const encoded = url.slice(url.indexOf(marker) + marker.length).split("?", 1)[0];
    const bytes = await readFile(decodeURI(encoded));
    return json({ type: "file", encoding: "base64", content: bytes.toString("base64") });
  }
  throw new Error(`unexpected GitHub URL ${url}`);
}

beforeEach(() => {
  Object.assign(process.env, {
    GITHUB_REPOSITORY: "opus99999/pulsechain-mcp",
    GITHUB_REPOSITORY_ID: "1320639709",
    GITHUB_REPOSITORY_OWNER: "opus99999",
    GITHUB_REPOSITORY_OWNER_ID: "212180323",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: "opus99999/pulsechain-mcp/.github/workflows/trusted-team-receipt-proof-backfill.yml@refs/heads/main",
    GITHUB_WORKFLOW_SHA: "e".repeat(40),
    GITHUB_SHA: "e".repeat(40),
    GITHUB_RUN_ID: "9000001",
    GITHUB_RUN_ATTEMPT: "1",
  });
});

afterEach(() => {
  process.env = { ...prior };
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("trusted-team receipt projector", () => {
  it("grants only the required future and backfill projection permissions", async () => {
    for (const workstream of ["signals-platform", "validator-flows", "identity-attribution", "investor-intelligence"]) {
      const workflow = await readFile(`.github/workflows/trusted-team-${workstream}.yml`, "utf8");
      expect(workflow).toMatch(/contents: write/);
      expect(workflow).toMatch(/issues: write/);
      expect(workflow).toMatch(/actions: read/);
      expect(workflow).toMatch(/id-token: write/);
    }
    const backfill = await readFile(".github/workflows/trusted-team-receipt-proof-backfill.yml", "utf8");
    expect(backfill).toMatch(/workflow_dispatch:/);
    expect(backfill).toMatch(/contents: read/);
    expect(backfill).toMatch(/issues: read/);
    expect(backfill).toMatch(/actions: read/);
    expect(backfill).toMatch(/id-token: write/);
    expect(backfill).not.toMatch(/inputs:/);
  });
  it("validates all four exact historical receipts and immutable repository manifests before OIDC projection", async () => {
    for (const expected of HISTORICAL_PROOFS) {
      globalThis.fetch = vi.fn(async (input, init) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/")) {
          expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-token");
          return githubResponse(url, expected);
        }
        if (url.includes("/api/v1/trusted-team/receipt-proofs/github")) {
          const envelope = JSON.parse(String(init?.body));
          expect(init?.headers).toMatchObject({ authorization: "Bearer oidc-token" });
          expect(envelope.proof.receipt_comment_id).toBe(expected.receipt_comment_id);
          return json({
            schema_version: "pulsechain-trusted-team-receipt-proof-receipt@1.0.0",
            accepted: true,
            replayed: false,
            new_events: 1,
            proof_event_id: envelope.proof.proof_event_id,
            canonical_duplicate_key: envelope.proof.canonical_duplicate_key,
            content_sha256: envelope.proof.content_sha256,
          });
        }
        throw new Error(`unexpected URL ${url}`);
      }) as typeof fetch;
      const result = await projectTrustedTeamReceipt(expected, { githubToken: "test-token", oidcToken: "oidc-token" });
      expect(result.accepted).toBe(true);
    }
  });

  it.each([
    ["wrong result", { result: "REJECTED" }],
    ["accepted boolean substitution", { result: undefined, accepted: true }],
    ["wrong workstream", { workstream_id: "identity-attribution" }],
    ["wrong commit", { commit: "0".repeat(40) }],
    ["wrong manifest", { manifest_sha256: `sha256:${"0".repeat(64)}` }],
    ["wrong artifact", { artifact_sha256: `sha256:${"0".repeat(64)}` }],
  ])("rejects %s", async (_name, change) => {
    const expected = HISTORICAL_PROOFS[0];
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) return githubResponse(url, expected, change);
      throw new Error("projection must not be reached");
    }) as typeof fetch;
    await expect(projectTrustedTeamReceipt(expected, { githubToken: "test-token", oidcToken: "oidc-token" })).rejects.toThrow();
  });

  it("rejects an owner-authored receipt imitation", async () => {
    const expected = HISTORICAL_PROOFS[0];
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith(`/issues/comments/${expected.receipt_comment_id}`)) return json({ ...comment(expected), user: { login: "opus99999", id: 212180323 } });
      throw new Error("projection must not be reached");
    }) as typeof fetch;
    await expect(projectTrustedTeamReceipt(expected, { githubToken: "test-token", oidcToken: "oidc-token" })).rejects.toThrow(/RECEIPT_COMMENT_IDENTITY_MISMATCH/);
  });
});

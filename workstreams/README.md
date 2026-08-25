# PulseChain trusted-team GitHub ledger bridge

This directory is the reviewed source template for the public repository
`opus99999/pulsechain-mcp`. All installed paths are new trusted-team ledger
paths. Existing PulseChain Signals source, workflows, history, and data remain
untouched.

Install the files as follows:

- `scripts/trusted-team-publish.mjs` → `scripts/trusted-team-publish.mjs`
- `workflows/trusted-team-*.yml` → `.github/workflows/trusted-team-*.yml`
- `workstreams/**` → `workstreams/**`

The four workflows are fixed to one workstream each. They accept an issue opened
by the fixed repository administrator with this exact title:

`[TRUSTED_TEAM <workstream>] PUBLISH <update_id>`

The issue body is one JSON document with schema
`pulsechain-trusted-team-publication@1.0.0`. It includes the complete final
response, public project-state metadata, next-work handoff, the expected bridge
repository head, the expected latest update ID, and metadata for one ZIP stored
in ChatGPT Library. ZIP bytes never enter Git.

Each accepted update creates only:

```text
workstreams/<workstream>/updates/<update_id>/summary.md
workstreams/<workstream>/updates/<update_id>/project_state.json
workstreams/<workstream>/updates/<update_id>/next_work_handoff.md
workstreams/<workstream>/updates/<update_id>/manifest.json
workstreams/<workstream>/latest.json
workstreams/<workstream>/index.json
```

The update directory is immutable. `latest.json` and `index.json` are mutable
only within that same workstream. No shared project file is required for
acceptance.

Four workstreams can publish concurrently. Each workflow serializes only its
own workstream. When another workstream advances `main`, the publisher rebuilds
the same update against the new head and retries a fast-forward push, up to four
attempts. It rejects any same-workstream advancement relative to the supplied
expected head or expected latest update ID.

The publisher validates fixed repository, owner, actor, event, branch, and
workflow identities. It rejects unknown request fields, unsafe paths, obvious
credential patterns, cross-workstream data, invalid artifact metadata, a dirty
checkout, unexpected diffs, reused update IDs, and non-ancestor expected heads.

The public site reads only the allowlisted trusted-team ledger paths from the
public repository. It resolves one commit first and reads all ledger paths from
that same commit. No private-repository credential is required or exposed.

# Runtime collaborator workspaces

This page is the normative workspace ownership and integration contract. Runtime participant/process authority remains in [`PROTOCOL.md`](PROTOCOL.md).

## Identity and ownership

`workspace-write` always means one Runtime-owned linked Git worktree. A writer never receives the main checkout as its cwd.

Each durable workspace records:

- logical canonical project root and Git common directory;
- exact base/head commits and private `refs/heads/runtime/collab/<workspace-id>` ref;
- exact Runtime-root worktree path;
- participant key, reserved holder generation, exact Pi-session or bridge owner, and profile;
- Pi single-use launch-token digest when applicable, exact Herdr binding, typed state, and handoff statistics.

The logical project root continues to derive participant identity. The workspace path is only the writer's cwd. Read-only collaborators keep the project read view and do not create worktrees.

## Provision and registration

A trusted `workspace-write` start reserves a new/vacant participant generation before Git or process launch. Runtime records `provisioning`, verifies a canonical non-bare repository and exact base commit, rejects repository-defined filter/merge attributes, then creates a unique branch/worktree. The worktree becomes `ready` only after exact Git registry/ref/path verification.

The controller durably records the exact create request ID before calling Runtime. If a response is lost, it retries exact recovery long enough to outlive the Git operation; unresolved authority remains durably visible rather than becoming an undiscoverable workspace. The controller then creates an empty no-focus, single-pane Herdr tab at that worktree and binds its pane, terminal, tab, workspace, and cwd.

For Pi, the child receives one random workspace token through process environment; Pi captures and deletes it before tools can inherit it, while only its digest is durable. Pi registration verifies the exact session header/file, Herdr identity/cwd, workspace record, caller/prior participant generations, and launch digest.

For native Claude Code/Codex, the workspace is owned from creation by the final bridge ID and target key. Bridge launch must repeat that exact workspace, caller, participant, holder generation, and Herdr identity. Registration verifies the reported generic bridge/cwd and atomically creates the final bridge target, activates the workspace, acquires the participant, and consumes bridge launch authority before acknowledgement. Reconnect revalidates the exact active holder/workspace generation after host awaits.

## Workspace states

- `provisioning`: durable intent exists; Git creation may be incomplete.
- `ready`: isolated worktree exists; no host is bound.
- `bound`: exact empty Herdr target is bound; registration is pending.
- `active`: exact collaborator generation may write.
- `retained`: target stopped or explicit retention; worktree preserved.
- `ready_handoff`: clean checkpoint and complete handoff evidence exist.
- `partial`: failed/cancelled work was checkpointed and preserved.
- `needs_attention`: Git/identity/cleanup was ambiguous; no destructive recovery occurs.
- `integrated`: exact staged result was finalized into main.
- `cleaned`: exact worktree/ref were removed and the tombstone remains.

Stop and cleanup are separate. Stand-down preserves the process and workspace. Exact stop closes the target and changes an active workspace to retained. Ambiguous Auto launch cleanup retains any workspace that a child may have modified; Auto never discards it.

## Safe Git boundary

Runtime requires Git 2.42 or newer. All commands are argv-only with bounded output/time and a scrubbed environment. Runtime disables inherited `GIT_*`, system/global configuration and attributes, hooks, signing, pagers/editors, fsmonitor, replacement refs, lazy fetch, terminal prompts, autostash, and submodule recursion.

Before checkout, checkpoint, or integration, Runtime inspects attributes at the exact source tree and rejects external clean/smudge filters and custom merge behavior. Changed path count/bytes, checked-out tree blobs, and committed handoff blobs are bounded. Escaping symlinks are rejected. Gitlink/submodule entries are rejected entirely for this initial workspace profile so nested state cannot be omitted. Sequencer state, overflow, identity drift, or an ambiguous Git result becomes `needs_attention` and remains preserved.

Checkpointing stages tracked/deleted/untracked nonignored paths, writes a tree, creates a fixed-identity `commit-tree`, and advances only the exact private ref with `update-ref <new> <old>` compare-and-swap. Existing commits must form a bounded linear nonempty range from base; merge and empty commits are rejected. Binary files, modes, renames (reported as delete/add for exact stats), deletions, and untracked files remain durable in commits.

## Handoff evidence

Checkpoint returns structural evidence, not approval:

```ts
{
  workspaceId: string;
  participantKey: string;
  holderGeneration: string;
  baseCommit: string;
  headCommit: string;
  branchRef: string;
  worktreePath: string;
  state: "ready_handoff" | "partial" | "needs_attention";
  commits: string[];
  changedFiles: number;
  additions: number;
  deletions: number;
  taskStatus?: "completed" | "failed" | "cancelled";
}
```

Human summaries and collaborator messages remain display-only. They never authorize checkpoint, integration, finalization, or discard. Review exact `baseCommit..headCommit` with `safe_diff`.

A typed bounded-task result from a workspace-bound participant includes Runtime-derived snapshot evidence: workspace ID, current durable base/head, private branch artifact reference, durable state, capture timestamp, and whether bounded Git status observed dirty paths. Publishing a result does not checkpoint, commit, stop, integrate, or clean the workspace. Dirty evidence therefore honestly means the reported head does not yet include all working-tree effects.

## Staged integration

`prepare_integration` is separately confirmed and records current main branch/head `M`. Runtime creates `refs/heads/runtime/integrate/<integration-id>` in another isolated worktree at `M`, then cherry-picks the complete ordered source commit list.

- Clean preparation records exact prepared head `I`; main remains unchanged.
- Conflict records bounded paths and current integration head, retains index/sequencer/worktree state, and leaves main unchanged.
- No automatic abort, reset, skip, rebase, or conflict resolution occurs.

`finalize_integration` is always confirmed. Runtime serializes its own operations for the Git common directory, then rechecks exact main branch, `HEAD == M`, clean main index/worktree, exact clean integration identity, and prepared head. It performs a hook-disabled `merge --ff-only I` and accepts success only when main is clean at exactly `I`. Main advance or dirt fails closed and preserves staging.

## Cleanup and discard

Automatic cleanup is limited to exact clean integrated/finalized worktrees. Runtime verifies common directory, path, branch ref, expected tip, worktree registry, cleanliness, absence of ignored files, and absence of sequencer state; it removes the exact worktree without force and deletes only the exact ref with CAS.

Unintegrated workspace discard and prepared/conflicted integration discard require explicit trusted confirmation. Dirty workspace changes are checkpointed first when safe. Confirmed integration discard may use exact force removal only after path/ref/tip/common-directory verification; it never prunes, resets, or removes unrelated worktrees. Unsafe symlinks, filters, unknown heads, stale registry entries, or other ambiguity remain retained for operator recovery.

## Concurrency and recovery

Writers use distinct branches, indexes, and paths, so no file locks are needed between collaborators. Runtime serializes its own Git operations per common directory; external cooperative Git users remain outside that in-process lease, so finalization always rechecks main immediately before Git's own ref/index locks.

State intents precede filesystem mutation. After restart, reconnect and every later workspace operation revalidate durable records against exact Git/Herdr identities before proceeding; prose is never parsed. A failed operation records `needs_attention` when it can do so safely. `reconcile` may advance a still-`provisioning` record to ready only when its exact base/path/ref/common-directory worktree already exists; missing or mismatched paths, refs, sequencers, or worktree registrations become/remain blocked for explicit recovery. Runtime never treats ambiguity as permission to delete work.

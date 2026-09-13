# Operator-driven Pi / Claude Code / Codex MCP ring

## Result and scope

One live six-message exchange completed on implementation commit `c91c3cfb4d1b198c946025d66d48151ea9159220`, using Pi 0.85.1, Claude Code 2.1.267, Codex 0.154.0 and Herdr 0.9.0/protocol22. Both native clients reached interactive readiness and held Runtime identities through supported `herdr agent start`. Each used its real provider session, normal native configuration/hooks/permissions, and a separate Runtime-owned `workspace-write` worktree.

Pi used the actual shared stdio MCP tools. The operator directly submitted the native read-skill/peers/receive/reply/send prompts and relayed their results. There was no automatic native input, keystroke injection, pane scraping for coordination, custom launcher/proxy or permission autoacceptance. The six package-owned MCP tools and [shared skill](../../skills/collaborator-messaging/SKILL.md) were common to all three clients; normal native mode can still expose other user tools, servers and hooks.

The controller's read-only Runtime metadata audit corroborated all six publications, exact recipient namespace bindings, retrieval offers, client-receipt timestamps and three reply correlations. **Native reports were user-relayed, not independently certified from raw provider transcripts.** This proves the recorded operator-driven exchange, not unattended delivery, native admission, provider commit, fsync durability or general release readiness.

## Correlation ledger

Probe nonce: `e6ee788b-d363-4f69-b133-8d8e740025a4`. Original operation IDs are `ring-<nonce>-<leg>`; no namespace or operation identity was replaced to complete the exchange.

| Leg | Route | Event ID | Reply to |
|---|---|---|---|
| A | Pi → Claude | `evt_d7165c46-a142-427c-9f3d-1096f5a6f1e7` | — |
| B | Claude → Codex | `evt_db69df31-965f-4974-b6ee-f5cb616ba0b4` | — |
| C | Claude → Pi | `evt_b9135b13-fa17-4dad-b69e-3d1deb3e01a4` | A |
| D | Codex → Claude | `evt_8019c577-1674-4298-9a99-d5b3f6d5bb32` | B |
| E | Codex → Pi | `evt_87f3966e-a693-4685-8a83-dc5f0778484e` | — |
| F | Pi → Codex | `evt_050eacca-0493-4826-bc8f-ac6ef3ea6a51` | E |

Pi directly retrieved and explicitly receipted C, then retrieved E and atomically receipted it while publishing F. Claude reported receiving D, correlated to B; Codex reported receiving F, correlated to E. The audit checked the original publication operation/event/sequence/time, source participant generation, destination namespace and offer timestamps for every leg, both before and after cleanup. All six offers had `receivedAt`; all six events remained ordinary-mail `delivery.status: pending`, with no native claim. These facts are compatible: client receipt never becomes a native ACK or task completion.

Recorded namespaces:

- Pi: `msg_c7719bd5-8d62-4926-8b43-92899e710973`.
- Claude: `msg_308a1bfa-48a8-4c2a-94ad-c90ee6ca3e63`.
- Codex: `msg_24a08785-0433-46ef-83fb-c9a768b979b4`.

These identifiers are historical evidence, not credentials or instructions to retry through a successor.

## Identity, credential scope and cleanup

Claude's provider session was `35b2dce0-ed52-49d5-8f38-f0e1cda32207` in `w7:t6D/p6M`; Codex's was `01a0979e-18e6-73b3-b2c0-5b3ba6fac4e6` in `w7:t6E/p6N`. Managed names were validated separately from these provider IDs. Runtime metadata bound their namespaces to the actual target kinds/drivers, clients, terminals and holder generations.

A scoped read-only credential audit checked three messaging descriptors and two native-control files: owned regular files, mode `0600`, exact bindings, and descriptor-secret hashes matching the grants. Seven current authentication values were absent from the controller Pi transcript, 238 tracked regular repository files and the six original owned process command lines. Values were never printed or copied into the report. This was not an audit of native transcripts, global settings/auth, all historical credentials or ambient hooks.

The operator separately approved stopping both test collaborators and cleaning only their unchanged workspaces. A bounded observer captured pidfds, original start ticks and immediate child relationships for these two trees before supported Runtime stop:

- Claude: shell `895058` → provider `895423` → Node `895639`.
- Codex: shell `917540` → provider `918042` → Node `918445`.

All six pidfds signaled exit. The original PIDs and exact tabs were absent, and no visible process cwd remained at or below either owned worktree, **before** checkpoint or workspace cleanup. Both checkpoints had base=head=`c91c3cf`, no commits and zero changed files. Confirmed cleanup removed `workspace_259726dd-2e7e-4349-8977-07e4f6758693` and `workspace_ddac5909-b94d-441f-92f2-b0a087006ab1`; both participants became vacant. Cleanup's workspace `taskStatus: cancelled` is not a native task result or a reversal of the messaging receipts.

The controller remained held and the protected Runtime remained PID `2140998`, start ticks `1279257388`, with the same socket owner. No global auth or retained Runtime credential records were deleted, no daemon restart occurred during this cleanup, and no unrelated session was targeted. Earlier failed-launch qualifications remain in the [plan](MCP-PLAN.md): the first worktree recovery preceded shell stop, and `YyhZLq` lacked original PID capture. This successful cleanup does not retroactively certify either history.

## Retained evidence and validation

Private artifacts were retained under `/tmp/pi-kit-native-ring-audit-Oc52vZ/`:

- `verify.py`, `verified.before-stop.json`, `verified.json`: bounded read-only state audit and credential-free projections with source-state hashes.
- `scan.py`, `secret-scan.json`: scoped current-secret checks while the original processes were live. Its live-identity precondition no longer holds after cleanup; do not weaken it to rerun the scan.
- `watch-exit.py`, `process-exit.json`: six original pidfd exits; Job `j_mtzop2ss_7608bca3` completed successfully. The observer sent no signals and performed no cleanup.
- `cleanup.json`: removed workspaces, vacant test participants, preserved controller and Runtime.

The first metadata verifier used the wrong reply-field location; it was corrected against `HostedMailboxMessageEvent.inReplyToEventId` and rerun successfully without changing production state or code. These are controller-generated audit artifacts, not independent raw-live certification. Private `/tmp` evidence is unpackaged and not guaranteed permanent retention.

Implementation `c91c3cf` previously passed `env -u PI_PACKAGE_DIR VITEST_MAX_WORKERS=1 npm run check`: **628 tests across 51 files**, typecheck, mode smokes, supply-chain audit and package dry-run, with a separate frozen implementation review. That review and automated suite did not themselves establish this live ring. The default-parallel Vitest timeout cause remains unestablished; no runner configuration was changed.

## Remaining guarantees: explicitly not established

- **Reliable notification:** Pi hints are best-effort, reference-only and at most once per offered event; navigation, new human input, a crash or response loss can lose a hint. No automatic ambiguous replay is added. Herdr does not supply the editor/process-incarnation/human-priority authority required for safe automatic Claude/Codex wakes, which remain blocked.
- **Native/Pi admission and fsync:** a Runtime client receipt is not native admission or a provider commit. Readable Pi JSONL and SDK hooks do not prove fsync-based crash durability. This ring did not inspect native transcript persistence or prove exactly-once input consumption.
- **Daemon handoff and repair:** the separately approved controlled restart preserved the Runtime instance/v12 data, changed its epoch and allowed fresh controller MCP authority. It did not prove atomic daemon-owned delivery handoff, every crash/uncertain-operation interleaving, or orphaned/expired descriptor repair. The bounded startup lease is not indefinite permission-prompt continuation.
- **Configuration and confinement:** the configuration hash binds compiled arguments and skill content, not ambient hooks/settings or a later skill read. Normal native worktree cwd is not filesystem/tool confinement; guarded read-only provisioning remains separate.
- **Release:** this one exchange covers all six directed client pairings under explicit human initiation. It does not certify general rollout, automatic task/Monitor delivery, all startup environments or every lifecycle failure case. See the [Pi lifecycle evidence](MCP-LIVE-PI.md) and [remaining gates](MCP-PLAN.md#remaining-implementation-gates).

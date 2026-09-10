# Live Pi-to-Pi messaging proof

## Result

**Passed on 2026-09-10**, against implementation `6cfcf34e50367a47a716055a401e8ed0a746dd9e` (Runtime schema v12).

Two fresh, isolated **real Pi 0.85.1 TUIs** ran the user's configured `openai-codex/gpt-6-astra` model, with thinking set to low. Herdr 0.9.0/protocol 22 owned their interactive processes and the private Runtime service. This run used the actual Herdr host verifier, default Runtime extension and stdio MCP subprocesses—not the deterministic test provider, a mocked host, or an in-process messaging substitute.

This proves one live Pi-to-Pi ping/reply exchange. It is **not** a Claude Code/Codex native-client test or a rollout into existing sessions.

## Observed exchange

1. Alice's initial, explicitly authorized CLI prompt caused actual MCP peer discovery, one send to Bob and one publication-status lookup.
2. Bob's idle TUI received a body-free Runtime reference automatically. Its model discovered its namespace, retrieved the exact body through MCP and issued one correlated reply. The reply atomically recorded Bob's client receipt.
3. Alice's idle TUI received the reply reference automatically, retrieved its body and explicitly recorded client receipt. Neither agent polled for messages or sent another reply.

| Evidence | Alice → Bob | Bob → Alice |
|---|---|---|
| Event | `evt_4eb09110-3b2c-42c4-bc9a-de80437aed28` | `evt_ff7031ae-b54b-4464-a40e-b6a5ff08c0ad` |
| Recipient namespace | `msg_8be6856f-a8a0-4a1f-a9c3-21e9cac2ff48` | `msg_74376e96-71da-410f-b187-a9357acb0c37` |
| Publication time, Unix ms | 1789060139339 | 1789060154190 |
| Reference offered | 1789060139371 | 1789060155323 |
| Body offered | 1789060148005 | 1789060159573 |
| Client received | 1789060154190 | 1789060164845 |

Bodies were the exact `LIVE_PING:` / `LIVE_PONG:` test strings with nonce `89ff7cc2-0bad-452b-b9dc-7b163ce81006`. The second event's `inReplyToEventId` names the first. There were exactly two publications, one reference and one successful receive result per Pi, five model tool calls from Alice and three from Bob. All calls used the six-tool MCP allowlist.

Both ordinary events correctly retained native `delivery.status: pending`. Runtime claims and wakes were empty. **Client receipt was not promoted to native admission.**

## Transcript verification

A separate Python verifier read complete JSONL records after process quiescence. It checked:

- exact session header, project, participant/namespace/target and reference binding;
- the receive result's tool-call ID and exact namespace/event arguments;
- complete body equality in both native tool-result content and details;
- reference → retrieval → client-receipt time ordering;
- each receive result on the persisted linear ancestry, with no branch or compaction entries;
- actual assistant provider/model metadata and absence of unexpected tools;
- unchanged file bytes during verification.

| Pi | Session ID | Transcript SHA-256 |
|---|---|---|
| Alice | `b905c032-0944-4075-927a-fddb1f06cb99` | `cd2d823b56375ee8178ed4e3292da70744178751f9d76a0241803469fd8e7aea` |
| Bob | `8fa710c5-cdf0-4994-8f50-a0647afe48fc` | `3105090043dc13a7449d3732e145908873f91cef262a54dfc32d3907ad871be2` |

The verifier used ordinary read-only file reads, not Pi's potentially writing `loadEntriesFromFile()`. Persisted readable records are evidence of observed session storage, **not an fsync/crash-durability certificate**.

## Isolation, cleanup and retained artifacts

- Fresh private root: `/tmp/pi-kit-live-pair-iJuRIU/`; no existing sessions or installed package files were changed.
- Created workspace `w12` and exact tabs `w12:t1`–`w12:t3` with `--no-focus`. No automatic terminal prompt or keystroke wake was used; Alice's initial task was a startup argument, and both subsequent notifications came through Pi's SDK.
- Five owned process identities (service, two Pis, two MCP children) were captured with PID/start-time identity. Cleanup used pinned process signals, confirmed quiescence and removed the exact owned tabs. The copied auth file was deleted only afterward.
- Both transcripts were scanned against four credential values (OAuth access/refresh and two MCP secrets): **zero leaks**. Credentials and raw private authority artifacts are not reproduced here.
- Successful bounded driver: Job `j_mtvs7cal_f889fffa`, exit 0. Retained `run.mjs`, `manifest.json`, `sessions/*.jsonl`, `verify.py` and sanitized `verified.json` under the private root. These temporary artifacts are not packaged or guaranteed to survive host cleanup; hashes and conclusions are recorded here.
- Independent read-only cross-check command: `python3 /tmp/pi-kit-live-pair-iJuRIU/verify.py`, exit 0. This was a separate verifier program, not an independent human/agent review.

An earlier **setup-only** attempt at `/tmp/pi-kit-live-pair-W64NN2/` failed because the driver assumed every successful Herdr command returned JSON; `pane run` returned empty output. No model agents were launched in that attempt. The driver was corrected to accept empty successful command responses and typed already-absent cleanup results. Its one service process was confirmed quiescent and its auth copy removed (`j_mtvs5z3j_50a6cc2b`, exit 0). No production guard was relaxed to make the live proof pass.

## Follow-up: copied-transcript history proof

**Passed on 2026-09-10** using the installed Pi 0.85.1 binary in bounded RPC runs against separate copies of both live transcripts. This was a history-only test: **Runtime/MCP extensions and authority were not loaded**, and no new mail was sent. It does not certify live Runtime re-registration or descriptor renewal across these transitions.

A private probe extension called public `ctx.navigateTree()` and `ctx.reload()` methods and exposed read-only branch/context snapshots. RPC `get_entries` and `get_messages` supplied complete records and active messages. After navigation, a test-only custom metadata entry anchored the selected position for restart; this does not assert that navigation alone persists a leaf selection. Both original transcript files remained unchanged, and their complete bytes remained the prefix of each modified copy.

The following outcomes were checked for **both** sessions:

| Phase | Exact receive result in active messages | Receive entry on ancestry | Exact record still stored |
|---|---|---|---|
| Open saved transcript | Yes | Yes | Yes |
| Navigate before receive; reload; process restart | No | No | Yes |
| Restore original branch; reload | Yes | Yes | Yes |
| Compact; process restart; reload | No | Yes | Yes |

Compaction used Pi's normal summarizer with the configured `openai-codex/gpt-6-astra` model, no custom-summary hook, and an explicitly small **`keepRecentTokens: 1`** to exercise removal from active context. The two compactions reported 2,878 and 1,315 usage tokens. This is not a default-threshold or large-body test. The observed compaction entries used `firstKeptEntryId`, not `retainedTail`.

Crucially, **absence of the original receive result is not absence of all body text**: both short test bodies still appeared somewhere in the compacted active messages. Summary/tail text is not the original structured tool-result evidence and cannot guarantee lossless preservation of arbitrary bodies, receipt tokens or authority. After compaction, all-entry/ancestry inspection and active model context answer different questions.

- Successful driver: **`j_mtvsy5z5_db646c93`**, exit 0, 46 seconds; six owned Pi children closed before copied auth deletion. No persistent/interactive server was started.
- Separate read-only verifier: `python3 /tmp/pi-kit-history-nICIKL/verify.py`, exit 0; checked raw RPC results, all 18 phase snapshots, original byte prefixes, exact receive records and unchanged source/copy bytes during verification. Lifecycle records separately confirmed six RPC startups and six reloads.
- Private artifacts: `/tmp/pi-kit-history-nICIKL/{run.mjs,probe.ts,report.json,verified.json,verify.py,copies/,rpc-*.jsonl}`. Thirteen RPC/lifecycle/compaction output files were scanned against copied OAuth credentials with zero leaks; the auth copy is absent. Temporary artifacts are not packaged or guaranteed to survive host cleanup.
- Final copied transcript SHA-256: Alice `1a03030d416884f945bd5fef74866a7b40a188e97adf153d9e77cd991212818e`; Bob `e95391c8b8e52b70fd9f4356b3932001c2b1d7eea9cc35179338c54f3cffd7bf`.

## Still not established

- Runtime-enabled restart/reload/tree/compaction re-registration, descriptor renewal and new messaging in live sessions. The copied-transcript proof above establishes storage/context behavior only.
- Reliable notification after a lost reference response: hints intentionally remain best-effort and non-replayed.
- Fsync-based Pi body admission or daemon handoff guarantees.
- A live three-harness ring. Claude/Codex automatic wakes remain blocked on safe native editor/process admission; prior isolated publications are separate historical evidence.
- Installation or production rollout. Those still require explicit approval.

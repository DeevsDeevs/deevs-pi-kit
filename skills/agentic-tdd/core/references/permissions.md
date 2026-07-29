# Permissions and protected surfaces

Separation is useful only when it creates different information exposure, different
writable surfaces, different evidence obligations, independent falsification, or
deterministic gates outside the authoring agent's control.

| Surface | Coordinator | Architect | Logic-hunter | Developer | Tester-qa | Release reviewer | External challenger |
|---|---|---|---|---|---|---|---|
| Production code | protect | read | read | **write in LOOP** | read | read | read |
| Architecture | version/freeze | **propose in PLAN** | comment | critique | critique | read | challenge |
| Contract | version/freeze | comment | **propose in PLAN** | critique | critique | read | challenge |
| Protected acceptance tests | protect via engine | read | propose semantic cases | read/run only | **write outside DEV control** | read | read/challenge |
| Developer-local tests | record | read | read | **write** | read | read | read |
| Oracle/reference | freeze | review | **propose/supervise** | review/run | test/challenge | read | challenge |
| Tolerances | freeze | comment | propose | no write | challenge | verify | challenge |
| Performance harness | protect | propose constraints | comment | run, never weaken | propose/validate | verify | inspect |
| Findings | version/dispose | submit | submit/classify | respond | submit/classify | review dispositions | submit |
| Waivers | record | no | no | no | no | verify | no |

Authors may propose revisions to their own artifacts; a revision becomes authoritative
only after independent review and a coordinator version bump. The implementation agent
never controls the evidence that judges it.

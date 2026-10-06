import { interruptAndResume } from "./cli-kill9-resume.mjs";

// A graceful quit kills the worker on the way out; that run is interrupted, not failed, and resumes on reopen.
export default {
	name: "cli-quit-resume",
	gate: "M4",
	timeoutMs: 120_000,
	run: (t) => interruptAndResume(t, (lead) => lead.close()),
};

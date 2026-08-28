import { createHash } from "node:crypto";

const turnId = process.argv[2] ?? "turn";
const priorSession = process.argv[3] ?? "";
let input = "";
for await (const chunk of process.stdin) input += String(chunk);
const sessionId = priorSession || `fake_${createHash("sha256").update(turnId).digest("hex").slice(0, 24)}`;
const directive = input.trim();
if (directive.startsWith("sleep:")) await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, Math.max(0, Number(directive.slice(6)) || 0))));
if (directive === "malformed") {
	process.stdout.write("{bad\n");
	process.exit(0);
}
if (directive === "no-terminal") {
	process.stdout.write(`${JSON.stringify({ type: "text", text: "missing terminal" })}\n`);
	process.exit(0);
}
if (directive === "secret-env") {
	const leaked = Object.keys(process.env).filter((key) => /TOKEN|SECRET|REGISTRATION|RUNTIME_SOCKET|HERDR/i.test(key));
	process.stdout.write(`${JSON.stringify({ type: "terminal", status: leaked.length ? "failed" : "completed", body: leaked.join(",") || "secret-free", sessionAdvance: "none", sessionId })}\n`);
	process.exit(0);
}
if (directive === "terminal-then-sleep") {
	process.stdout.write(`${JSON.stringify({ type: "terminal", status: "completed", body: "terminal-before-cancel", sessionAdvance: "committed", sessionId })}\n`);
	await new Promise((resolve) => setTimeout(resolve, 30_000));
	process.exit(0);
}
process.stdout.write(`${JSON.stringify({ type: "session", sessionId })}\n`);
process.stdout.write(`${JSON.stringify({ type: "text", text: `fake:${directive}` })}\n`);
const failed = directive === "fail";
process.stdout.write(`${JSON.stringify({ type: "terminal", status: failed ? "failed" : "completed", body: failed ? "fake failure" : `fake:${directive}`, sessionAdvance: "committed", sessionId })}\n`);
process.exit(failed ? 1 : 0);

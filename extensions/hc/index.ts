import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function hcExtension(pi: ExtensionAPI): void {
	const terminal = process.env.HC_TERMINAL_ID;
	if (!terminal) return;
	const line = `You run inside hc (\`${terminal}\`). For long-running work or other machines, load the \`hc\` skill; to run other agents (pi, Claude Code, Codex), the \`hc-flow\` skill.`;
	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		if (!options.appendSystemPrompt.includes(line)) options.appendSystemPrompt = [options.appendSystemPrompt, line].filter(Boolean).join("\n\n");
	});
}

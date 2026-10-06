// Scripted model over HTTP. The first user message `POLYGON {json}` is the script; the next step is derived
// from the transcript, never from server state, so kill -9, resume, CLI children and in-process agents all work.
// A string arg "$/re/" is replaced by the last match of re in the transcript (ids the script cannot know upfront).
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const text = (c) => typeof c === "string" ? c
	: (c ?? []).map((b) => b.type === "tool_use" ? `toolCall:${b.id}` : b.type === "tool_result" ? text(b.content) : b.text ?? "").join("\n");
const images = (messages) => messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((b) => b.type === "image" || b.type === "image_url" || b.type === "input_image").length : 0), 0);

/** `fallback` scripts a conversation that carries none, such as a collaborator woken by mail. */
export function nextStep(messages, fallback) {
	const host = messages.find((m) => m.role === "user" && text(m.content).includes("POLYGON {"));
	if (!host && !fallback) return { text: "polygon:no-script" };
	const raw = host ? text(host.content) : "";
	const script = host ? JSON.parse(raw.slice(raw.indexOf("POLYGON ") + 8).split("\n")[0]) : fallback;
	const said = messages.filter((m) => m.role === "assistant")
		.map((m) => `${text(m.content)}\n${(m.tool_calls ?? []).map((t) => `toolCall:${t.id}`).join("\n")}`).join("\n");
	const last = messages.findLastIndex((m) => m.role === "assistant");
	const fresh = messages.slice(last + 1).map((m) => text(m.content)).join("\n");
	const step = script.steps.find((s) => !said.includes(s.tool ? `toolCall:${s.id}` : `[polygon:${s.id}]`) && (!s.on || fresh.includes(s.on)));
	if (!step) return { text: "[polygon:idle]", agent: script.agent };
	const transcript = messages.map((m) => text(m.content)).join("\n");
	const args = Object.fromEntries(Object.entries(step.args ?? {}).map(([k, v]) => [k, resolveRef(v, transcript)]));
	return { ...step, args, agent: script.agent };
}

function resolveRef(value, transcript) {
	if (typeof value !== "string" || !/^\$\/.+\/$/.test(value)) return value;
	return transcript.match(new RegExp(value.slice(2, -1), "g"))?.at(-1) ?? value;
}

const reply = (step) => step.id ? `[polygon:${step.id}] ${step.text ?? ""}` : step.text;

/**
 * `marks` is the scenario's live list of strings to look for; each request logs the ones its raw body contains.
 * `scripts` maps a model id to its fallback script; scenarios fill it through `t.scripts`.
 */
export function startPuppet(logFile, marks = [], scripts = {}) {
	const log = (wire, url, request, step, messages) => {
		const raw = JSON.stringify(request);
		appendFileSync(logFile, JSON.stringify({
			at: Date.now(), wire, url, agent: step.agent ?? null, step: step.id ?? null, tool: step.tool ?? null, model: request.model,
			messages: messages.length, images: images(messages), tools: (request.tools ?? []).map((t) => t.function?.name ?? t.name ?? t.type),
			serviceTier: request.service_tier ?? null, marks: marks.filter((m) => raw.includes(m)),
		}) + "\n");
	};
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (d) => { chunks.push(d); });
		req.on("end", () => {
			// Pi's openai-codex SSE transport sends its body zstd-compressed, as the Codex backend accepts.
			const body = req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(Buffer.concat(chunks)) : Buffer.concat(chunks);
			const request = JSON.parse(body.toString() || "{}");
			if (req.url.includes("/responses")) return responses(res, request, log, req.url);
			const wire = req.url.includes("/chat/completions") ? "chat" : req.url.includes("/messages") ? "anthropic" : null;
			// Token counts and health probes such as Claude's /api/hello are answered outside the request log.
			if (req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"input_tokens":1}'); }
			if (!wire) { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
			const messages = request.messages ?? [];
			const step = nextStep(messages, scripts[request.model]);
			log(wire, req.url, request, step, messages);
			if (wire === "anthropic") return anthropic(res, request, step);
			chat(res, request, step);
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

function chat(res, request, step) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (delta, finish, usage) => res.write(`data: ${JSON.stringify({ id: "polygon", object: "chat.completion.chunk", created: 0, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`);
	if (step.tool) chunk({ role: "assistant", tool_calls: [{ index: 0, id: step.id, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, null);
	else chunk({ role: "assistant", content: reply(step) }, null);
	const prompt = step.usage ?? 1;
	// `delayMs` holds the stream open after the first chunk, so a scenario can kill a lead mid-stream.
	setTimeout(() => {
		if (res.destroyed) return;
		chunk({}, step.tool ? "tool_calls" : "stop", { prompt_tokens: prompt, completion_tokens: 1, total_tokens: prompt + 1 });
		res.end("data: [DONE]\n\n");
	}, step.delayMs ?? 0);
}

function anthropic(res, request, step) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	ev("message_start", { message: { id: "msg_polygon", type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
	if (step.tool) {
		ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: step.id, name: step.tool, input: {} } });
		ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.args) } });
	} else {
		ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply(step) } });
	}
	ev("content_block_stop", { index: 0 });
	ev("message_delta", { delta: { stop_reason: step.tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
	ev("message_stop", {});
	res.end();
}

// OpenAI Responses (Codex): input items are mapped onto the message shape nextStep reads.
function responses(res, request, log, url) {
	const items = typeof request.input === "string" ? [{ type: "message", role: "user", content: request.input }] : request.input ?? [];
	const messages = items.map((i) => i.type === "function_call" ? { role: "assistant", content: `toolCall:${i.call_id}` }
		: i.type === "function_call_output" ? { role: "tool", content: typeof i.output === "string" ? i.output : JSON.stringify(i.output) }
		: i.type === "message" || i.role ? { role: i.role, content: typeof i.content === "string" ? i.content : i.content ?? [] }
		: { role: "other", content: "" });
	const step = nextStep(messages);
	log("responses", url, request, step, messages);
	res.writeHead(200, { "content-type": "text/event-stream" });
	const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	const item = step.tool
		? { type: "function_call", id: `fc_${step.id}`, call_id: step.id, name: step.tool, arguments: JSON.stringify(step.args), status: "completed" }
		: { type: "message", id: "msg_polygon", role: "assistant", status: "completed", content: [{ type: "output_text", text: reply(step), annotations: [] }] };
	ev("response.created", { response: { id: "resp_polygon", object: "response", status: "in_progress", model: request.model, output: [] } });
	ev("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", ...(item.content ? { content: [] } : {}) } });
	if (!step.tool) ev("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
	ev("response.output_item.done", { output_index: 0, item });
	ev("response.completed", { response: { id: "resp_polygon", object: "response", status: "completed", model: request.model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
	res.end();
}

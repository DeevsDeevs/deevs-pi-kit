const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const BODY = text(16384);

export const tools = [
	{
		name: "collaborator_peers",
		description: "Who is in this project: you and the collaborators you can mail.",
		properties: {},
		required: [],
		readOnlyHint: true,
	},
	{
		name: "collaborator_inbox",
		description: "Your unread mail with bodies, oldest first; what it returns is marked read. Answer with collaborator_reply.",
		properties: {},
		required: [],
		readOnlyHint: false,
	},
	{
		name: "collaborator_send",
		description: "Mail a collaborator by participantId.",
		properties: { participantId: text(64), body: BODY },
		required: ["participantId", "body"],
		readOnlyHint: false,
	},
	{
		name: "collaborator_reply",
		description: "Reply to a message you received, by its eventId.",
		properties: { eventId: text(200), body: BODY },
		required: ["eventId", "body"],
		readOnlyHint: false,
	},
];

export const toolDefinitions = tools.map(({ properties, required, readOnlyHint, ...tool }) => ({
	...tool,
	inputSchema: { type: "object", properties, required, additionalProperties: false },
	annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: false },
}));

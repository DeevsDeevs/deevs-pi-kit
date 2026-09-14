const text = (maxLength = 200) => ({ type: "string", minLength: 1, maxLength });
export const tools = [
	{
		name: "collaborator_peers",
		description: "List up to 12 peers in your exact project/protocol, your identity and retry namespace. Follow nextCursor for more.",
		properties: { cursor: text(512) },
		required: [],
		readOnlyHint: true,
	},
	{
		name: "collaborator_send",
		description: "Durably publish explicit mail to an existing peer and return its event ID. "
			+ "Reuse the same operationId and input after uncertainty; a repeat returns the original event, changed input is a conflict.",
		properties: { namespaceId: text(), participantId: text(64), operationId: text(), body: text(16384) },
		required: ["namespaceId", "participantId", "operationId", "body"],
		readOnlyHint: false,
	},
	{
		name: "collaborator_status",
		description: "Look up one of your operations in this namespace and return the published message,"
			+ " including its readAt time when the recipient has recorded receipt.",
		properties: { namespaceId: text(), operationId: text() },
		required: ["namespaceId", "operationId"],
		readOnlyHint: true,
	},
	{
		name: "collaborator_receive",
		description: "Return the complete body of one message addressed to your participant. "
			+ "Repeating receive is safe and changes nothing; it does not record receipt or settle native delivery.",
		properties: { namespaceId: text(), eventId: text() },
		required: ["namespaceId", "eventId"],
		readOnlyHint: false,
	},
	{
		name: "collaborator_received",
		description: "Record that you read an exact message by setting its readAt time. Repeat safely; the body stays retrievable. "
			+ "This is not native admission, provider commit or task completion.",
		properties: { namespaceId: text(), eventId: text() },
		required: ["namespaceId", "eventId"],
		readOnlyHint: false,
	},
	{
		name: "collaborator_reply",
		description: "Publish a reply to the original sender of an exact message, correlated by inReplyToEventId, and set that message's readAt. "
			+ "Reuse namespace, operation ID and all input after uncertainty.",
		properties: { namespaceId: text(), operationId: text(), eventId: text(), body: text(16384) },
		required: ["namespaceId", "operationId", "eventId", "body"],
		readOnlyHint: false,
	},
];

export const toolDefinitions = tools.map(({ properties, required, readOnlyHint, ...tool }) => ({
	...tool,
	inputSchema: { type: "object", properties, required, additionalProperties: false },
	annotations: { readOnlyHint, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}));

/** The one tool a native collaborator gets; messages to it arrive by themselves, so it has nothing to poll. */
export const sendMessage = {
	name: "SendMessage",
	description: "Message the lead (to: \"main\") or another collaborator by name. Attach images by absolute path.",
	inputSchema: {
		type: "object",
		properties: {
			to: { type: "string" },
			message: { type: "string" },
			images: { type: "array", items: { type: "string" } },
		},
		required: ["to", "message"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

export const toolDefinitions = [sendMessage];

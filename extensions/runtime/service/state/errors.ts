export class HostedStateStorageError extends Error {
	readonly code = "storage_error" as const;

	readonly uncertain: boolean;

	constructor(message: string, uncertain = false) {
		super(message);
		this.uncertain = uncertain;
	}
}

export class HostedStateConflictError extends Error {
	readonly code: "conflict";

	constructor(code: "conflict", message: string) {
		super(message);
		this.code = code;
	}
}

export function storageError(message: string, cause: unknown, uncertain = false): HostedStateStorageError {
	if (cause instanceof HostedStateStorageError && !uncertain) return cause;
	return new HostedStateStorageError(`${message}: ${cause instanceof Error ? cause.message : String(cause)}`, uncertain);
}

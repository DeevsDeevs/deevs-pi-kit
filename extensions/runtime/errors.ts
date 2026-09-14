/** Every code Runtime puts on the wire. A failure carrying none is reported as an invalid request. */
export type RuntimeErrorCode =
	| "invalid_request"
	| "unsupported_version"
	| "capability_unavailable"
	| "not_found"
	| "conflict"
	| "registration_stale"
	| "identity_mismatch"
	| "host_unavailable"
	| "busy"
	| "storage_error"
	| "internal";

/** The one typed failure every Runtime service throws, so the dispatcher never has to duck-type a code. */
export class RuntimeError extends Error {
	readonly code: RuntimeErrorCode;

	constructor(code: RuntimeErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

export function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
	return cause instanceof Error && "code" in cause;
}

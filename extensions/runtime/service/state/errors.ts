import { RuntimeError } from "../../errors.ts";

export class HostedStateStorageError extends RuntimeError {
	/** True when the write may have reached disk, so the store must be recovered before it is trusted again. */
	readonly uncertain: boolean;
	/** True when nothing reached disk because the state would exceed its byte cap. */
	readonly full: boolean;

	constructor(message: string, uncertain = false, full = false) {
		super("storage_error", message);
		this.uncertain = uncertain;
		this.full = full;
	}
}

export function storageError(message: string, cause: unknown, uncertain = false): HostedStateStorageError {
	if (cause instanceof HostedStateStorageError && !uncertain) return cause;
	return new HostedStateStorageError(`${message}: ${cause instanceof Error ? cause.message : String(cause)}`, uncertain);
}

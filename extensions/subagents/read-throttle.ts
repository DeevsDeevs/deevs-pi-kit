type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

interface ReadState {
	lastReadAt?: number;
	tail: Promise<void>;
}

export class ReadThrottle {
	private readonly states = new Map<string, ReadState>();
	private readonly now: () => number;
	private readonly sleep: Sleep;

	constructor(now: () => number = Date.now, sleep: Sleep = sleepFor) {
		this.now = now;
		this.sleep = sleep;
	}

	async wait(id: string, intervalMs: number, signal?: AbortSignal): Promise<void> {
		if (intervalMs <= 0 || signal?.aborted) return;
		const state = this.states.get(id) ?? { tail: Promise.resolve() };
		this.states.set(id, state);
		const previous = state.tail;
		let release!: () => void;
		state.tail = new Promise<void>((resolve) => {
			release = resolve;
		});

		await previous;
		try {
			if (signal?.aborted) return;
			if (state.lastReadAt !== undefined) {
				const remainingMs = state.lastReadAt + intervalMs - this.now();
				if (remainingMs > 0) await this.sleep(remainingMs, signal);
			}
			if (!signal?.aborted) state.lastReadAt = this.now();
		} finally {
			release();
		}
	}

	clear(id: string): void {
		this.states.delete(id);
	}
}

async function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0 || signal?.aborted) return;
	await new Promise<void>((resolve) => {
		let timer: NodeJS.Timeout;
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

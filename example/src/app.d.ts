declare global {
	const __DEV_WORKER_PORT__: number;

	namespace App {
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
		}
	}
}

export {};

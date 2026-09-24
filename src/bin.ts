import { main, USAGE, UsageError } from './cli.js';

main(process.argv.slice(2)).catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`sveltekit-add-worker-exports: ${message}\n`);
	if (error instanceof UsageError) {
		process.stderr.write(`\n${USAGE}`);
	}
	process.exitCode = 1;
});

/**
 * Every port the acceptance tests listen on, in one place: the test files
 * run in parallel and must not collide, and globalSetup.ts checks up front
 * that all of them are free.
 *
 * `sidecarPort` must match the `devPort` the app passes to
 * `addWorkerExports` (example uses the default, 8787).
 */
export interface AppPorts {
	vitePort: number;
	sidecarPort: number;
	previewPort: number;
	inspectorPort: number;
}

export const EXAMPLE_PORTS: AppPorts = {
	vitePort: 5301,
	sidecarPort: 8787,
	previewPort: 5302,
	inspectorPort: 9401
};

export const EXAMPLE_V3_PORTS: AppPorts = {
	vitePort: 5303,
	sidecarPort: 8788,
	previewPort: 5304,
	inspectorPort: 9402
};

export const CLOUDFLARE_ENV_PORTS = {
	vitePort: 5305,
	sidecarPort: 8789
};

export const ALL_PORTS: number[] = [
	...Object.values(EXAMPLE_PORTS),
	...Object.values(EXAMPLE_V3_PORTS),
	...Object.values(CLOUDFLARE_ENV_PORTS)
];

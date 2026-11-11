/**
 * Translates wrangler module `rules` into an esbuild plugin so the build-mode
 * bundle honors the same contract wrangler's own bundler honors in dev.
 *
 * Wrangler config rules look like
 * `{ "type": "Text", "globs": ["**\/*.sql"], "fallthrough": true }` and make
 * matching imports resolve to the file contents (as a string for `Text`, an
 * `ArrayBuffer` for `Data`). Wrangler applies them — plus a set of default
 * rules — whenever it bundles a worker (`wrangler dev`, `wrangler deploy`,
 * and this plugin's dev sidecar). The build-mode `esbuild.build()` call in
 * `patchWorker` runs outside wrangler, so without this plugin a `.sql` import
 * that works in dev fails the production build with "No loader is configured".
 * See https://github.com/oselvar/sveltekit-add-worker-exports/issues/8
 *
 * Wrangler exports none of its rules machinery, but miniflare (already a peer
 * dependency) exports `compileModuleRules`/`testRegExps` with the same
 * fallthrough semantics, so only wrangler's default rule list is replicated
 * here. One divergence: miniflare compiles globs with `globstar: true` and
 * matches resolved file paths, while wrangler's bundler compiles with
 * `globstar: false` and matches import specifiers. The canonical shapes
 * (`**\/*.sql`, `**\/*.txt`) behave identically under both.
 */

import type { Plugin as EsbuildPlugin, OnLoadResult } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { compileModuleRules, globsToRegExps, testRegExps } from 'miniflare';

/**
 * Declared here rather than imported: miniflare 4 calls these `ModuleRuleType`
 * / `ModuleRule`, miniflare 5 renamed them to `V4ModuleRuleType` /
 * `V4ModuleRule`. The shape is identical in both, so this type-checks against
 * whichever miniflare the consumer has.
 */
export type ModuleRuleType =
	| 'ESModule'
	| 'CommonJS'
	| 'Text'
	| 'Data'
	| 'CompiledWasm'
	| 'PythonModule'
	| 'PythonRequirement';

/** A module rule in miniflare's shape. */
export interface ModuleRule {
	type: ModuleRuleType;
	include: string[];
	fallthrough?: boolean;
}

interface CompiledModuleRule {
	type: ModuleRuleType;
	include: ReturnType<typeof globsToRegExps>;
}

/** A module rule as it appears in wrangler config (miniflare uses `include`). */
export interface WranglerRule {
	type: ModuleRuleType;
	globs: string[];
	fallthrough?: boolean;
}

export function toModuleRule(rule: WranglerRule): ModuleRule {
	return { type: rule.type, include: rule.globs, fallthrough: rule.fallthrough };
}

/**
 * Wrangler's `DEFAULT_MODULE_RULES` (src/deployment-bundle/rules.ts), in
 * miniflare's shape. Wrangler appends these after user rules everywhere it
 * bundles, so the plugin does the same — `.sql`, `.txt`, and `.html` imports
 * work with no `rules` config at all, matching `wrangler dev`.
 */
export const WRANGLER_DEFAULT_MODULE_RULES: ModuleRule[] = [
	{ type: 'Text', include: ['**/*.txt', '**/*.html', '**/*.sql'] },
	{ type: 'Data', include: ['**/*.bin'] },
	{ type: 'CompiledWasm', include: ['**/*.wasm', '**/*.wasm?module'] }
];

/** Rules esbuild already handles natively; wrangler skips these too. */
function isJavaScriptRuleType(type: ModuleRuleType): boolean {
	return type === 'ESModule' || type === 'CommonJS';
}

/**
 * Builds an esbuild plugin that applies `userRules` followed by wrangler's
 * default rules, first match wins. Matching honors wrangler's fallthrough
 * semantics: the first rule of a type without `fallthrough: true` finalises
 * that type, and a file matching only a later (shadowed) rule of that type
 * fails the build with wrangler's own actionable error.
 */
export function createModuleRulesPlugin(userRules: ModuleRule[]): EsbuildPlugin {
	const allRules = [...userRules, ...WRANGLER_DEFAULT_MODULE_RULES];

	// `compileModuleRules` keeps the same rules wrangler's `parseRules` keeps.
	// JS rules are dropped from the match loop — esbuild's default handling is
	// exactly their meaning — but they still participate in fallthrough
	// finalisation above, like in wrangler.
	// The cast pins `type` to our `ModuleRuleType`: miniflare 4 declares it as
	// a `z.infer<…>` that TypeScript 7 doesn't narrow to the string union.
	const kept = (compileModuleRules(allRules) as CompiledModuleRule[]).filter(
		(rule) => !isJavaScriptRuleType(rule.type)
	);

	// Recompute which rules `compileModuleRules` dropped, so files matching
	// only a shadowed rule get wrangler's error instead of esbuild's opaque
	// "No loader is configured".
	const finalisedTypes = new Set<ModuleRuleType>();
	const removed: Array<{ rule: ModuleRule; include: ReturnType<typeof globsToRegExps> }> = [];
	for (const rule of allRules) {
		if (finalisedTypes.has(rule.type)) {
			removed.push({ rule, include: globsToRegExps(rule.include, { endAnchor: true }) });
		} else if (!rule.fallthrough) {
			finalisedTypes.add(rule.type);
		}
	}

	return {
		name: 'wrangler-module-rules',
		setup(build) {
			build.onLoad({ filter: /.*/ }, async (args): Promise<OnLoadResult | undefined> => {
				// Match with `/` separators so globs behave the same on Windows.
				const path = args.path.replaceAll('\\', '/');
				for (const rule of kept) {
					if (testRegExps(rule.include, path)) {
						return loadModule(rule.type, args.path);
					}
				}
				for (const { rule, include } of removed) {
					if (testRegExps(include, path)) {
						return {
							errors: [
								{
									text:
										`The file ${args.path} matched a module rule in your configuration ` +
										`(${JSON.stringify({ type: rule.type, globs: rule.include })}), but was ignored because a ` +
										'previous rule with the same type was not marked as `fallthrough = true`.'
								}
							]
						};
					}
				}
				return undefined;
			});
		}
	};
}

async function loadModule(type: ModuleRuleType, path: string): Promise<OnLoadResult> {
	switch (type) {
		case 'Text':
			// esbuild's text loader default-exports the contents as a string,
			// exactly like a workerd Text module.
			return { contents: await readFile(path, 'utf-8'), loader: 'text' };
		case 'Data': {
			// workerd Data modules import as an ArrayBuffer, but esbuild's
			// `binary` loader yields a Uint8Array — so inline a stub that
			// decodes to the exact runtime type.
			const base64 = (await readFile(path)).toString('base64');
			return {
				contents:
					`const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0));\n` +
					'export default bytes.buffer;\n',
				loader: 'js'
			};
		}
		default:
			// CompiledWasm / PythonModule / PythonRequirement: workerd loads
			// these as separate deploy-time modules, which can't be inlined
			// into the single-file _extra_exports.js bundle. (Workers forbids
			// compiling WebAssembly from bytes at runtime.)
			return {
				errors: [
					{
						text:
							`"${type}" module rules are not supported by @oselvar/sveltekit-add-worker-exports: ` +
							`${path} cannot be inlined into the single-file worker bundle.`
					}
				]
			};
	}
}

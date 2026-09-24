// Ambient module declarations. Kept out of app.d.ts: that file is a module
// (it has `export {}`), and a wildcard `declare module` inside a module is an
// augmentation that declares nothing.

// Imported as a string via wrangler's default `**/*.sql` Text module rule.
declare module '*.sql' {
	const contents: string;
	export default contents;
}

import { describe, expect, it } from 'vitest';
import { getNodejsCompatMode } from './index';

describe('getNodejsCompatMode', () => {
	it('is null without flags before nodejs_compat became the default', () => {
		expect(getNodejsCompatMode('2026-05-13', [])).toBe(null);
		expect(getNodejsCompatMode(undefined, undefined)).toBe(null);
	});

	it('is v1 for nodejs_compat before the v2 switch-over date', () => {
		expect(getNodejsCompatMode('2024-09-22', ['nodejs_compat'])).toBe('v1');
	});

	it('is v2 for nodejs_compat from the v2 switch-over date', () => {
		expect(getNodejsCompatMode('2024-09-23', ['nodejs_compat'])).toBe('v2');
		expect(getNodejsCompatMode('2026-05-13', ['nodejs_compat'])).toBe('v2');
	});

	it('honors no_nodejs_compat_v2', () => {
		expect(getNodejsCompatMode('2026-05-13', ['nodejs_compat', 'no_nodejs_compat_v2'])).toBe(
			'v1'
		);
	});

	it('is v2 for nodejs_compat_v2 at any date', () => {
		expect(getNodejsCompatMode('2020-01-01', ['nodejs_compat_v2'])).toBe('v2');
	});

	it('is v2 without flags from the date nodejs_compat is on by default', () => {
		expect(getNodejsCompatMode('2026-08-03', [])).toBe(null);
		expect(getNodejsCompatMode('2026-08-04', [])).toBe('v2');
	});

	it('is null from the default-on date when both compat modes are switched off', () => {
		expect(getNodejsCompatMode('2026-08-04', ['no_nodejs_compat', 'no_nodejs_compat_v2'])).toBe(
			null
		);
	});

	it('is als for nodejs_als alone', () => {
		expect(getNodejsCompatMode('2026-05-13', ['nodejs_als'])).toBe('als');
	});
});

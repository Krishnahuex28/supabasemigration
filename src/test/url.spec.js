'use strict';

const { describe, it, expect } = require('vitest');
const fc = require('fast-check');
const { extractBucketAndPathFromUrl, buildPublicUrl, normalizePath } = require('../utils/url');

describe('normalizePath', () => {
	it('removes leading slashes and backslashes', () => {
		expect(normalizePath('/a/b')).toBe('a/b');
		expect(normalizePath('\\a\\b')).toBe('a/b');
	});

	it('returns null for falsy', () => {
		expect(normalizePath('')).toBeNull();
		expect(normalizePath(null)).toBeNull();
	});
});

describe('extractBucketAndPathFromUrl', () => {
	it('parses valid public URLs', () => {
		const url = 'https://proj.supabase.co/storage/v1/object/public/resumes/123/resume.pdf';
		expect(extractBucketAndPathFromUrl(url)).toEqual({ bucket: 'resumes', path: '123/resume.pdf' });
	});

	it('returns null on invalid input', () => {
		expect(extractBucketAndPathFromUrl('not a url')).toBeNull();
		expect(extractBucketAndPathFromUrl('https://x/y')).toBeNull();
	});

	it('property: round trip with buildPublicUrl', () => {
		fc.assert(
			fc.property(
				fc.webUrl(),
				fc.string({ minLength: 1, maxLength: 20, regex: /^[a-z0-9-]+$/ }),
				fc.array(fc.string({ minLength: 1, maxLength: 12, regex: /^[A-Za-z0-9_.-]+$/ }), { minLength: 1, maxLength: 5 }).map(parts => parts.join('/')),
				(projectUrl, bucket, objectPath) => {
					const url = buildPublicUrl(projectUrl, bucket, objectPath);
					const parsed = extractBucketAndPathFromUrl(url);
					return parsed && parsed.bucket === bucket && parsed.path === normalizePath(objectPath);
				}
			)
		);
	});
});



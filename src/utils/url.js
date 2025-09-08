'use strict';

const PUBLIC_PREFIX = '/storage/v1/object/public/';

function normalizePath(input) {
	if (!input) return null;
	return input.replace(/^\/+/, '').replace(/\\/g, '/');
}

function extractBucketAndPathFromUrl(urlString) {
	if (!urlString || typeof urlString !== 'string') return null;
	try {
		const url = new URL(urlString);
		const idx = url.pathname.indexOf(PUBLIC_PREFIX);
		if (idx === -1) return null;
		const relative = url.pathname.substring(idx + PUBLIC_PREFIX.length);
		const [bucket, ...rest] = relative.split('/');
		if (!bucket || rest.length === 0) return null;
		return { bucket, path: rest.join('/') };
	} catch (_e) {
		return null;
	}
}

function buildPublicUrl(projectUrl, bucket, objectPath) {
	if (!projectUrl || !bucket || !objectPath) return null;
	const base = projectUrl.replace(/\/$/, '');
	const path = normalizePath(objectPath);
	return `${base}${PUBLIC_PREFIX}${bucket}/${path}`;
}

module.exports = {
	normalizePath,
	extractBucketAndPathFromUrl,
	buildPublicUrl,
};



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

// Data URL helpers
function isDataUrl(value) {
	return typeof value === 'string' && /^data:[^;]+;base64,/.test(value);
}

function dataUrlToBuffer(dataUrl) {
	if (!isDataUrl(dataUrl)) return null;
	const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
	if (!match) return null;
	const mimeType = match[1];
	const base64 = match[2];
	const buffer = Buffer.from(base64, 'base64');
	const extension = mimeTypeToExtension(mimeType);
	return { buffer, mimeType, extension };
}

function mimeTypeToExtension(mimeType) {
	switch (mimeType) {
		case 'image/png':
			return 'png';
		case 'image/jpeg':
		case 'image/jpg':
			return 'jpg';
		case 'image/webp':
			return 'webp';
		case 'image/gif':
			return 'gif';
		default:
			return 'bin';
	}
}

module.exports = {
	normalizePath,
	extractBucketAndPathFromUrl,
	buildPublicUrl,
	isDataUrl,
	dataUrlToBuffer,
};



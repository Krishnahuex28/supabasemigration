'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { extractBucketAndPathFromUrl, buildPublicUrl, normalizePath, isDataUrl, dataUrlToBuffer } = require('./utils/url');


const OLD_SUPABASE_URL = process.env.OLD_SUPABASE_URL;
const OLD_SUPABASE_KEY = process.env.OLD_SUPABASE_KEY;
const NEW_SUPABASE_URL = process.env.NEW_SUPABASE_URL;
const NEW_SUPABASE_KEY = process.env.NEW_SUPABASE_KEY;
const COUNTRY_FILTER = process.env.COUNTRY_FILTER || 'LK';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || 'tmp';
const AVATAR_BUCKET = process.env.AVATAR_BUCKET || 'talentprofilepictures';
const RETRY_MAX = Number(process.env.RETRY_MAX || 5);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 500);
const AVATAR_MAX_BYTES = Number(process.env.AVATAR_MAX_BYTES || 5_000_000); // 5MB default
const AVATAR_MAX_DIM = Number(process.env.AVATAR_MAX_DIM || 1024);
const AVATAR_ALLOWED_MIME = (process.env.AVATAR_ALLOWED_MIME || 'image/jpeg,image/png,image/gif')
	.split(',')
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 200);

// Validate env only when executed directly. When imported for tests, we allow missing envs.
if (require.main === module) {
	if (!OLD_SUPABASE_URL || !OLD_SUPABASE_KEY || !NEW_SUPABASE_URL || !NEW_SUPABASE_KEY) {
		console.error('Missing required environment variables. See .env.example');
		process.exit(1);
	}
}

let oldSupabase = createClient(OLD_SUPABASE_URL, OLD_SUPABASE_KEY);
let newSupabase = createClient(NEW_SUPABASE_URL, NEW_SUPABASE_KEY);

function setSupabaseClients(oldClient, newClient) {
	oldSupabase = oldClient;
	newSupabase = newClient;
}

async function withRetry(fn, label) {
	let attempt = 0;
	for (;;) {
		try {
			return await fn();
		} catch (err) {
			attempt += 1;
			if (attempt > RETRY_MAX) {
				throw err;
			}
			const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 100);
			console.warn(`Retry ${attempt}/${RETRY_MAX} after error in ${label}: ${err.message}. Waiting ${delay}ms...`);
			await new Promise((res) => setTimeout(res, delay));
		}
	}
}

async function compressAvatarIfTooLarge(inputBuffer, inputMimeType) {
	try {
		if (!inputBuffer || inputBuffer.length <= AVATAR_MAX_BYTES) return { buffer: inputBuffer, mimeType: inputMimeType, extension: mimeTypeToExtSafe(inputMimeType) };
		// Lazy require to avoid hard dependency during tests when not needed
		// eslint-disable-next-line global-require
		const sharp = require('sharp');
		let pipeline = sharp(inputBuffer).rotate().resize({ width: AVATAR_MAX_DIM, height: AVATAR_MAX_DIM, fit: 'inside', withoutEnlargement: true });
		// Choose encoder strategy
		let targetMime = inputMimeType;
		let ext = mimeTypeToExtSafe(inputMimeType);
		const isJpeg = /jpeg/.test(inputMimeType);
		const isPng = /png/.test(inputMimeType);
		const isWebp = /webp/.test(inputMimeType);
		// Prefer webp for png to reduce size substantially
		if (isPng) {
			targetMime = 'image/webp';
			ext = 'webp';
		}
		let quality = 85;
		for (;;) {
			let encoded;
			if (/jpeg/.test(targetMime)) {
				encoded = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
			} else if (/webp/.test(targetMime)) {
				encoded = await pipeline.webp({ quality }).toBuffer();
			} else if (/png/.test(targetMime)) {
				encoded = await pipeline.png({ compressionLevel: 9 }).toBuffer();
			} else {
				// Fallback to webp
				targetMime = 'image/webp';
				ext = 'webp';
				encoded = await pipeline.webp({ quality }).toBuffer();
			}
			if (encoded.length <= AVATAR_MAX_BYTES || quality <= 50) {
				return { buffer: encoded, mimeType: targetMime, extension: ext };
			}
			quality -= 10;
		}
	} catch (_e) {
		// If compression fails for any reason, return original
		return { buffer: inputBuffer, mimeType: inputMimeType, extension: mimeTypeToExtSafe(inputMimeType) };
	}
}

function mimeTypeToExtSafe(mime) {
	if (!mime) return 'bin';
	if (/png/.test(mime)) return 'png';
	if (/jpeg|jpg/.test(mime)) return 'jpg';
	if (/webp/.test(mime)) return 'webp';
	if (/gif/.test(mime)) return 'gif';
	return 'bin';
}

function isMimeAllowed(mime) {
	if (!mime) return false;
	return AVATAR_ALLOWED_MIME.includes(mime.toLowerCase());
}

async function normalizeAndCompressAvatar(buffer, mimeType) {
	let workingBuffer = buffer;
	let workingMime = mimeType;
	// Ensure allowed format; if not, transcode to JPEG
	if (!isMimeAllowed(workingMime)) {
		const sharp = require('sharp');
		workingBuffer = await sharp(workingBuffer).rotate().toFormat('jpeg', { quality: 85, mozjpeg: true }).toBuffer();
		workingMime = 'image/jpeg';
	}
	// Compress if over size/dimension limits
	const compressed = await compressAvatarIfTooLarge(workingBuffer, workingMime);
	return compressed; // { buffer, mimeType, extension }
}

async function fetchProfilesToMigrate() {
	const { data, error } = await withRetry(
		() =>
			oldSupabase
				.from('profiles')
				.select('id, email, resume_url, avatar_url')
				.eq('country', COUNTRY_FILTER)
				.order('id', { ascending: true }),
		'fetchProfilesToMigrate'
	);
	if (error) throw error;
	return data || [];
}

async function fetchProfilesBatch(offset, limit) {
	const { data, error } = await withRetry(
		() =>
			oldSupabase
				.from('profiles')
				.select('id, email, resume_url, avatar_url')
				.eq('country', COUNTRY_FILTER)
				.order('id', { ascending: true })
				.range(offset, offset + limit - 1),
		'fetchProfilesBatch'
	);
	if (error) throw error;
	return data || [];
}

async function downloadFromOld(bucket, objectPath) {
	const cleanPath = normalizePath(objectPath);
	const { data, error } = await withRetry(
		() => oldSupabase.storage.from(bucket).download(cleanPath),
		`download ${bucket}/${cleanPath}`
	);
	if (error) throw error;
	const localPath = path.join(DOWNLOAD_DIR, bucket, cleanPath);
	fs.mkdirSync(path.dirname(localPath), { recursive: true });
	const buffer = Buffer.from(await data.arrayBuffer());
	fs.writeFileSync(localPath, buffer);
	return localPath;
}

async function uploadToNew(bucket, objectPath, localPath) {
	const cleanPath = normalizePath(objectPath);
	const fileBuffer = fs.readFileSync(localPath);
	const contentType = guessContentTypeFromPath(cleanPath);
	const { error } = await withRetry(
		() => newSupabase.storage.from(bucket).upload(cleanPath, fileBuffer, { upsert: true, contentType }),
		`upload ${bucket}/${cleanPath}`
	);
	if (error) throw error;
	return buildPublicUrl(NEW_SUPABASE_URL, bucket, cleanPath);
}

async function uploadBufferToNew(bucket, objectPath, buffer, contentType) {
	const cleanPath = normalizePath(objectPath);
	const { error } = await withRetry(
		() => newSupabase.storage.from(bucket).upload(cleanPath, buffer, { upsert: true, contentType }),
		`upload ${bucket}/${cleanPath}`
	);
	if (error) throw error;
	return buildPublicUrl(NEW_SUPABASE_URL, bucket, cleanPath);
}

function guessContentTypeFromPath(p) {
	const ext = (p.split('.').pop() || '').toLowerCase();
	switch (ext) {
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'png':
			return 'image/png';
		case 'webp':
			return 'image/webp';
		case 'gif':
			return 'image/gif';
		case 'pdf':
			return 'application/pdf';
		case 'wav':
			return 'audio/wav';
		case 'mp3':
			return 'audio/mpeg';
		case 'm4a':
			return 'audio/mp4';
		case 'ogg':
			return 'audio/ogg';
		case 'aac':
			return 'audio/aac';
		case 'svg':
			return 'image/svg+xml';
		case 'avif':
			return 'image/avif';
		default:
			return 'application/octet-stream';
	}
}

async function getStagedbucketRow(userId) {
	const { data, error } = await withRetry(
		() => newSupabase.from('stagedbuckets').select('user_id, resume_url, avatar_url').eq('user_id', userId).maybeSingle(),
		'get stagedbuckets row'
	);
	if (error) throw error;
	return data || null;
}

async function upsertStagedbucketRow(userId, updated, existing) {
	const payload = {
		user_id: userId,
		resume_url: updated.resume_url ?? (existing ? existing.resume_url : ''),
		avatar_url: updated.avatar_url ?? (existing ? existing.avatar_url : null),
	};
	const { error } = await withRetry(
		() => newSupabase.from('stagedbuckets').upsert(payload, { onConflict: 'user_id' }),
		'upsert stagedbuckets'
	);
	if (error) throw error;
	return true;
}

function candidateObjectsForProfile(profile) {
	const outputs = [];
	const resumeInfo = extractBucketAndPathFromUrl(profile.resume_url);
	if (resumeInfo) outputs.push({ field: 'resume_url', source: 'storage', ...resumeInfo });
	const avatarInfo = extractBucketAndPathFromUrl(profile.avatar_url);
	if (avatarInfo) {
		outputs.push({ field: 'avatar_url', source: 'storage', ...avatarInfo });
	} else if (isDataUrl(profile.avatar_url)) {
		const parsed = dataUrlToBuffer(profile.avatar_url);
		const extension = parsed ? parsed.extension : 'bin';
		const objectPath = `avatars/${profile.id}-${Date.now()}.${extension}`;
		outputs.push({
			field: 'avatar_url',
			source: 'data-url',
			bucket: AVATAR_BUCKET,
			path: objectPath,
			dataUrl: profile.avatar_url,
		});
	}
	return outputs;
}

async function migrateStorageForProfiles(profiles) {
	const results = [];
	for (const profile of profiles) {
		const stagedExisting = await getStagedbucketRow(profile.id);
		let objects = candidateObjectsForProfile(profile);
		// Skip migrating fields already present in stagedbuckets
		if (stagedExisting) {
			objects = objects.filter((o) => {
				if (o.field === 'resume_url') {
					return !(typeof stagedExisting.resume_url === 'string' && stagedExisting.resume_url.trim() !== '');
				}
				if (o.field === 'avatar_url') {
					return !!(stagedExisting.avatar_url == null || String(stagedExisting.avatar_url).trim() === '');
				}
				return true;
			});
		}
		const updated = {};
		for (const obj of objects) {
			try {
				let newUrl;
				if (obj.source === 'data-url') {
					const parsed = dataUrlToBuffer(obj.dataUrl);
					if (!parsed) throw new Error('Invalid data URL');
					const normalized = await normalizeAndCompressAvatar(parsed.buffer, parsed.mimeType);
					newUrl = await uploadBufferToNew(
						obj.bucket,
						obj.path.replace(/\.[^.]+$/, `.${normalized.extension}`),
						normalized.buffer,
						normalized.mimeType
					);
				} else {
					const local = await downloadFromOld(obj.bucket, obj.path);
					if (obj.field === 'avatar_url') {
						const fileBuffer = fs.readFileSync(local);
						const guessed = guessContentTypeFromPath(obj.path);
						const normalized = await normalizeAndCompressAvatar(fileBuffer, guessed);
						const targetPath = obj.path.replace(/\.[^.]+$/, `.${normalized.extension}`);
						newUrl = await uploadBufferToNew(obj.bucket, targetPath, normalized.buffer, normalized.mimeType);
					} else {
						newUrl = await uploadToNew(obj.bucket, obj.path, local);
					}
				}
				updated[obj.field] = newUrl;
			} catch (e) {
				console.warn(`Skip ${obj.field} for profile ${profile.id}: ${e.message}`);
			}
		}
		// Upsert into stagedbuckets in NEW project
		try {
			await upsertStagedbucketRow(profile.id, updated, stagedExisting);
		} catch (e) {
			console.warn(`Failed to upsert stagedbuckets for profile ${profile.id}: ${e.message}`);
		}
		results.push({ id: profile.id, updated });
	}
	return results;
}

async function run() {
	console.log(`Fetching profiles for country: ${COUNTRY_FILTER}`);
	let offset = 0;
	let totalProcessed = 0;
	for (;;) {
		const batch = await fetchProfilesBatch(offset, BATCH_SIZE);
		if (!batch || batch.length === 0) break;
		console.log(`Processing batch offset=${offset} size=${batch.length}`);
		const migrationResults = await migrateStorageForProfiles(batch);
		for (const r of migrationResults) {
			console.log(JSON.stringify(r));
		}
		totalProcessed += batch.length;
		offset += BATCH_SIZE;
		if (batch.length < BATCH_SIZE) break;
	}
	console.log(`Done. Processed ${totalProcessed} profiles.`);
}

if (require.main === module) {
	run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = {
	fetchProfilesToMigrate,
	fetchProfilesBatch,
	migrateStorageForProfiles,
	candidateObjectsForProfile,
	downloadFromOld,
	uploadToNew,
	// test helpers
	setSupabaseClients,
	upsertStagedbucketRow,
};



'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { extractBucketAndPathFromUrl, buildPublicUrl, normalizePath, isDataUrl, dataUrlToBuffer } = require('./utils/url');`data:image/png;base64,...`


const OLD_SUPABASE_URL = process.env.OLD_SUPABASE_URL;
const OLD_SUPABASE_KEY = process.env.OLD_SUPABASE_KEY;
const NEW_SUPABASE_URL = process.env.NEW_SUPABASE_URL;
const NEW_SUPABASE_KEY = process.env.NEW_SUPABASE_KEY;
const COUNTRY_FILTER = process.env.COUNTRY_FILTER || 'LK';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || 'tmp';
const AVATAR_BUCKET = process.env.AVATAR_BUCKET || 'talentprofilepictures';

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

async function fetchProfilesToMigrate() {
	const { data, error } = await oldSupabase
		.from('profiles')
		.select('id, email, resume_url, avatar_url')
		.eq('country', COUNTRY_FILTER);
	if (error) throw error;
	return data || [];
}

async function downloadFromOld(bucket, objectPath) {
	const cleanPath = normalizePath(objectPath);
	const { data, error } = await oldSupabase.storage.from(bucket).download(cleanPath);
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
	const { error } = await newSupabase.storage.from(bucket).upload(cleanPath, fileBuffer, { upsert: true });
	if (error) throw error;
	return buildPublicUrl(NEW_SUPABASE_URL, bucket, cleanPath);
}

async function uploadBufferToNew(bucket, objectPath, buffer, contentType) {
	const cleanPath = normalizePath(objectPath);
	const { error } = await newSupabase.storage.from(bucket).upload(cleanPath, buffer, { upsert: true, contentType });
	if (error) throw error;
	return buildPublicUrl(NEW_SUPABASE_URL, bucket, cleanPath);
}

async function upsertStagedbucketRow(userId, updated) {
	const payload = {
		user_id: userId,
		resume_url: updated.resume_url ?? '',
		avatar_url: updated.avatar_url ?? null,
	};
	const { error } = await newSupabase.from('stagedbuckets').upsert(payload, { onConflict: 'user_id' });
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
		const objects = candidateObjectsForProfile(profile);
		if (objects.length === 0) {
			results.push({ id: profile.id, updated: {} });
			continue;
		}
		const updated = {};
		for (const obj of objects) {
			try {
				let newUrl;
				if (obj.source === 'data-url') {
					const parsed = dataUrlToBuffer(obj.dataUrl);
					if (!parsed) throw new Error('Invalid data URL');
					newUrl = await uploadBufferToNew(obj.bucket, obj.path, parsed.buffer, parsed.mimeType);
				} else {
					const local = await downloadFromOld(obj.bucket, obj.path);
					newUrl = await uploadToNew(obj.bucket, obj.path, local);
				}
				updated[obj.field] = newUrl;
			} catch (e) {
				console.warn(`Skip ${obj.field} for profile ${profile.id}: ${e.message}`);
			}
		}
		// Upsert into stagedbuckets in NEW project
		try {
			await upsertStagedbucketRow(profile.id, updated);
		} catch (e) {
			console.warn(`Failed to upsert stagedbuckets for profile ${profile.id}: ${e.message}`);
		}
		results.push({ id: profile.id, updated });
	}
	return results;
}

async function run() {
	console.log(`Fetching profiles for country: ${COUNTRY_FILTER}`);
	const profiles = await fetchProfilesToMigrate();
	console.log(`Found ${profiles.length} profile(s)`);
	const migrationResults = await migrateStorageForProfiles(profiles);
	console.log('Migration completed for storage objects. Summary of updated URLs:');
	for (const r of migrationResults) {
		console.log(JSON.stringify(r));
	}
}

if (require.main === module) {
	run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = {
	fetchProfilesToMigrate,
	migrateStorageForProfiles,
	candidateObjectsForProfile,
	downloadFromOld,
	uploadToNew,
	// test helpers
	setSupabaseClients,
	upsertStagedbucketRow,
};



'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { extractBucketAndPathFromUrl, buildPublicUrl, normalizePath } = require('./utils/url');

const OLD_SUPABASE_URL = process.env.OLD_SUPABASE_URL;
const OLD_SUPABASE_KEY = process.env.OLD_SUPABASE_KEY;
const NEW_SUPABASE_URL = process.env.NEW_SUPABASE_URL;
const NEW_SUPABASE_KEY = process.env.NEW_SUPABASE_KEY;
const COUNTRY_FILTER = process.env.COUNTRY_FILTER || 'LK';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || 'tmp';

if (!OLD_SUPABASE_URL || !OLD_SUPABASE_KEY || !NEW_SUPABASE_URL || !NEW_SUPABASE_KEY) {
	console.error('Missing required environment variables. See .env.example');
	process.exit(1);
}

const oldSupabase = createClient(OLD_SUPABASE_URL, OLD_SUPABASE_KEY);
const newSupabase = createClient(NEW_SUPABASE_URL, NEW_SUPABASE_KEY);

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

function candidateObjectsForProfile(profile) {
	const outputs = [];
	const resumeInfo = extractBucketAndPathFromUrl(profile.resume_url);
	if (resumeInfo) outputs.push({ field: 'resume_url', ...resumeInfo });
	const avatarInfo = extractBucketAndPathFromUrl(profile.avatar_url);
	if (avatarInfo) outputs.push({ field: 'avatar_url', ...avatarInfo });
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
				const local = await downloadFromOld(obj.bucket, obj.path);
				const newUrl = await uploadToNew(obj.bucket, obj.path, local);
				updated[obj.field] = newUrl;
			} catch (e) {
				console.warn(`Skip ${obj.field} for profile ${profile.id}: ${e.message}`);
			}
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
};



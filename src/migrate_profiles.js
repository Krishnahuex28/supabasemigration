'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const OLD_SUPABASE_URL = process.env.OLD_SUPABASE_URL;
const OLD_SUPABASE_KEY = process.env.OLD_SUPABASE_KEY;
const NEW_SUPABASE_URL = process.env.NEW_SUPABASE_URL;
const NEW_SUPABASE_KEY = process.env.NEW_SUPABASE_KEY;
const COUNTRY_FILTER = process.env.COUNTRY_FILTER || 'LK';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 200);
const RETRY_MAX = Number(process.env.RETRY_MAX || 5);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 500);

if (require.main === module) {
	if (!OLD_SUPABASE_URL || !OLD_SUPABASE_KEY || !NEW_SUPABASE_URL || !NEW_SUPABASE_KEY) {
		console.error('Missing required environment variables. See .env example in README');
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

// Columns to migrate from old profiles → new profiles
const PROFILE_COLUMNS = [
	'id', 'first_name', 'last_name', 'email', 'phone', 'avatar_url', 'role', 'job_title', 'primary_skill',
	'years_of_experience', 'english_level', 'bio', 'expected_salary', 'preferred_location', 'work_preference',
	'notice_period', 'resume_url', 'onboarding_completed', 'resume_data', 'work_experience', 'education_details',
	'license_details', 'english_test_completed', 'coding_test_completed', 'final_interview_completed', 'description',
	'ai_description', 'talent_profile_completed', 'skills', 'social_media', 'preferred_timezones', 'preferred_locations',
	'work_preferences', 'level', 'country', 'project_detail', 'why_create_account', 'company_preferences',
	'interview_attempt_count'
];

function buildSelect(columns) {
	return columns.join(', ');
}

async function fetchOldProfilesBatch(offset, limit) {
	const { data, error } = await withRetry(
		() => oldSupabase
			.from('profiles')
			.select(buildSelect(PROFILE_COLUMNS))
			.eq('country', COUNTRY_FILTER)
			.order('id', { ascending: true })
			.range(offset, offset + limit - 1),
		'fetchOldProfilesBatch'
	);
	if (error) throw error;
	return data || [];
}

async function fetchStagedbucketsForIds(profileIds) {
	if (!profileIds || profileIds.length === 0) return new Map();
	const { data, error } = await withRetry(
		() => newSupabase
			.from('stagedbuckets')
			.select('user_id, resume_url, avatar_url')
			.in('user_id', profileIds),
		'fetchStagedbucketsForIds'
	);
	if (error) throw error;
	const map = new Map();
	for (const row of data || []) {
		map.set(row.user_id, { resume_url: row.resume_url, avatar_url: row.avatar_url });
	}
	return map;
}

function mergeProfileWithStaged(profile, staged) {
	const merged = { ...profile };
	if (staged) {
		// Always prefer staged values when present ('' for resume_url and null for avatar_url are meaningful)
		if ('resume_url' in staged) merged.resume_url = staged.resume_url;
		if ('avatar_url' in staged) merged.avatar_url = staged.avatar_url;
	}
	return merged;
}

async function upsertProfiles(rows) {
	if (!rows || rows.length === 0) return;
	const { error } = await withRetry(
		() => newSupabase.from('profiles').upsert(rows, { onConflict: 'id' }),
		'upsertProfiles'
	);
	if (error) throw error;
}

async function run() {
	console.log(`Migrating profiles for country: ${COUNTRY_FILTER}`);
	let offset = 0;
	let total = 0;
	for (;;) {
		const batch = await fetchOldProfilesBatch(offset, BATCH_SIZE);
		if (!batch || batch.length === 0) break;
		const ids = batch.map((p) => p.id);
		const stagedMap = await fetchStagedbucketsForIds(ids);
		const rows = batch.map((p) => mergeProfileWithStaged(p, stagedMap.get(p.id)));
		await upsertProfiles(rows);
		total += rows.length;
		console.log(`Upserted ${rows.length} profiles (offset ${offset}).`);
		offset += BATCH_SIZE;
		if (batch.length < BATCH_SIZE) break;
	}
	console.log(`Done. Upserted ${total} profiles.`);
}

if (require.main === module) {
	run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = {
	setSupabaseClients,
	fetchOldProfilesBatch,
	fetchStagedbucketsForIds,
	mergeProfileWithStaged,
	upsertProfiles,
	run,
};



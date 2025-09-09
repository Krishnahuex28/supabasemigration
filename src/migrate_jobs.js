'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const OLD_SUPABASE_URL = process.env.OLD_SUPABASE_URL;
const OLD_SUPABASE_KEY = process.env.OLD_SUPABASE_KEY;
const NEW_SUPABASE_URL = process.env.NEW_SUPABASE_URL;
const NEW_SUPABASE_KEY = process.env.NEW_SUPABASE_KEY;
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 200);
const RETRY_MAX = Number(process.env.RETRY_MAX || 5);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 500);

if (require.main === module) {
	if (!OLD_SUPABASE_URL || !OLD_SUPABASE_KEY || !NEW_SUPABASE_URL || !NEW_SUPABASE_KEY) {
		console.error('Missing required environment variables. See README.');
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
			if (attempt > RETRY_MAX) throw err;
			const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 100);
			console.warn(`Retry ${attempt}/${RETRY_MAX} after error in ${label}: ${err.message || err}`);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

const JOB_COLUMNS = [
	'id', 'company_id', 'title', 'description', 'requirements', 'skills', 'salary_range', 'location', 'type',
	'status', 'created_at', 'updated_at', 'primary_skill', 'english_proficiency', 'years_experience', 'start_date',
	'working_hours', 'what_you_expect', 'what_you_get', 'annual_take_home', 'end_date', 'roles', 'location_type',
	'what_candidate_get', 'annual_take_home_range', 'job_location', 'description_link', 'currency'
];

function buildSelect(columns) {
	return columns.join(', ');
}

async function fetchOldJobsBatch(offset, limit) {
	const { data, error } = await withRetry(
		() => oldSupabase
			.from('jobs')
			.select(buildSelect(JOB_COLUMNS))
			.order('id', { ascending: true })
			.range(offset, offset + limit - 1),
		'fetchOldJobsBatch'
	);
	if (error) throw error;
	return data || [];
}

async function upsertJobs(rows) {
	if (!rows || rows.length === 0) return;
	const { error } = await withRetry(
		() => newSupabase.from('jobs').upsert(rows, { onConflict: 'id' }),
		'upsertJobs'
	);
	if (error) throw error;
}

async function run() {
	console.log('Migrating jobs');
	let offset = 0;
	let total = 0;
	for (;;) {
		const batch = await fetchOldJobsBatch(offset, BATCH_SIZE);
		if (!batch || batch.length === 0) break;
		await upsertJobs(batch);
		total += batch.length;
		console.log(`Upserted ${batch.length} jobs (offset ${offset}).`);
		offset += BATCH_SIZE;
		if (batch.length < BATCH_SIZE) break;
	}
	console.log(`Done. Upserted ${total} job row(s).`);
}

if (require.main === module) {
	run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = {
	setSupabaseClients,
	fetchOldJobsBatch,
	upsertJobs,
	run,
};



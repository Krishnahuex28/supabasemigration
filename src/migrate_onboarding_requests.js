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

const OR_COLUMNS = [
	'id', 'email', 'first_name', 'last_name', 'linkedin_url', 'type', 'status', 'company_name',
	'created_at', 'updated_at', 'onboarding_completed', 'verification_url'
];

function buildSelect(columns) {
	return columns.join(', ');
}

async function fetchOldOnboardingRequestsBatch(offset, limit) {
	const { data, error } = await withRetry(
		() => oldSupabase
			.from('onboarding_requests')
			.select(buildSelect(OR_COLUMNS))
			.eq('type', 'company')
			.order('id', { ascending: true })
			.range(offset, offset + limit - 1),
		'fetchOldOnboardingRequestsBatch'
	);
	if (error) throw error;
	return data || [];
}

async function upsertOnboardingRequests(rows) {
	if (!rows || rows.length === 0) return;
	const { error } = await withRetry(
		() => newSupabase.from('onboarding_requests').upsert(rows, { onConflict: 'id' }),
		'upsertOnboardingRequests'
	);
	if (error) throw error;
}

async function run() {
	console.log("Migrating onboarding_requests (type='company')");
	let offset = 0;
	let total = 0;
	for (;;) {
		const batch = await fetchOldOnboardingRequestsBatch(offset, BATCH_SIZE);
		if (!batch || batch.length === 0) break;
		await upsertOnboardingRequests(batch);
		total += batch.length;
		console.log(`Upserted ${batch.length} onboarding_requests (offset ${offset}).`);
		offset += BATCH_SIZE;
		if (batch.length < BATCH_SIZE) break;
	}
	console.log(`Done. Upserted ${total} onboarding_request row(s).`);
}

if (require.main === module) {
	run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = {
	setSupabaseClients,
	fetchOldOnboardingRequestsBatch,
	upsertOnboardingRequests,
	run,
};



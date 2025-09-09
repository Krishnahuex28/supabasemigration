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
const LOOKUP_CHUNK = Number(process.env.LOOKUP_CHUNK || 200);

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

const COMPANY_COLUMNS = [
	'id', 'name', 'description', 'logo_url', 'industry', 'country', 'website', 'referral_source',
	'created_at', 'updated_at', 'created_by', 'tech_stack', 'office_locations', 'benefits', 'workplace_culture',
	'profile_bio', 'technology_stack', 'first_job_created', 'company_profile_completed', 'social_media', 'timezones'
];

function buildSelect(columns) {
	return columns.join(', ');
}

async function fetchOldCompaniesBatch(offset, limit) {
	const { data, error } = await withRetry(
		() => oldSupabase
			.from('companies')
			.select(buildSelect(COMPANY_COLUMNS))
			.order('id', { ascending: true })
			.range(offset, offset + limit - 1),
		'fetchOldCompaniesBatch'
	);
	if (error) throw error;
	return data || [];
}

async function fetchStagedLogosByIds(ids) {
	if (!ids || ids.length === 0) return new Map();
	const map = new Map();
	for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
		const slice = ids.slice(i, i + LOOKUP_CHUNK);
		const { data, error } = await withRetry(
			() => newSupabase
				.from('staged_companylogo')
				.select('id, logo_url')
				.in('id', slice),
			'fetchStagedLogosByIds'
		);
		if (error) throw error;
		for (const row of data || []) map.set(row.id, row.logo_url || null);
	}
	return map;
}

function mergeCompanyWithStagedLogo(company, stagedLogoUrl) {
	if (stagedLogoUrl && String(stagedLogoUrl).trim() !== '') {
		return { ...company, logo_url: stagedLogoUrl };
	}
	return company;
}

async function upsertCompanies(rows) {
	if (!rows || rows.length === 0) return;
	const { error } = await withRetry(
		() => newSupabase.from('companies').upsert(rows, { onConflict: 'id' }),
		'upsertCompanies'
	);
	if (error) throw error;
}

async function run() {
	console.log('Migrating companies (overlaying logo_url from staged_companylogo)');
	let offset = 0;
	let total = 0;
	for (;;) {
		const batch = await fetchOldCompaniesBatch(offset, BATCH_SIZE);
		if (!batch || batch.length === 0) break;
		const ids = batch.map((c) => c.id);
		const stagedLogos = await fetchStagedLogosByIds(ids);
		const rows = batch.map((c) => mergeCompanyWithStagedLogo(c, stagedLogos.get(c.id)));
		await upsertCompanies(rows);
		total += rows.length;
		console.log(`Upserted ${rows.length} companies (offset ${offset}).`);
		offset += BATCH_SIZE;
		if (batch.length < BATCH_SIZE) break;
	}
	console.log(`Done. Upserted ${total} company row(s).`);
}

if (require.main === module) {
	run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = {
	setSupabaseClients,
	fetchOldCompaniesBatch,
	fetchStagedLogosByIds,
	mergeCompanyWithStagedLogo,
	upsertCompanies,
	run,
};



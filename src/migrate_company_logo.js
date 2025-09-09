'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { extractBucketAndPathFromUrl } = require('./utils/url');
const { downloadFromOld, uploadToNew, setSupabaseClients } = require('./migrate_storage');

const OLD_SUPABASE_URL = process.env.OLD_SUPABASE_URL;
const OLD_SUPABASE_KEY = process.env.OLD_SUPABASE_KEY;
const NEW_SUPABASE_URL = process.env.NEW_SUPABASE_URL;
const NEW_SUPABASE_KEY = process.env.NEW_SUPABASE_KEY;
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 200);
const RETRY_MAX = Number(process.env.RETRY_MAX || 5);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 500);
const STAGED_LOOKUP_CHUNK = Number(process.env.STAGED_LOOKUP_CHUNK || 200);

if (require.main === module) {
	if (!OLD_SUPABASE_URL || !OLD_SUPABASE_KEY || !NEW_SUPABASE_URL || !NEW_SUPABASE_KEY) {
		console.error('Missing required environment variables. See README.');
		process.exit(1);
	}
}

let oldSupabase = createClient(OLD_SUPABASE_URL, OLD_SUPABASE_KEY);
let newSupabase = createClient(NEW_SUPABASE_URL, NEW_SUPABASE_KEY);
setSupabaseClients(oldSupabase, newSupabase);

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

async function fetchCompaniesBatch(offset, limit) {
	const { data, error } = await withRetry(
		() => oldSupabase
			.from('companies')
			.select('id, logo_url')
			.order('id', { ascending: true })
			.range(offset, offset + limit - 1),
		'fetchCompaniesBatch'
	);
	if (error) throw error;
	return data || [];
}

async function fetchExistingStaged(ids) {
	if (!ids || ids.length === 0) return new Map();
	const m = new Map();
	for (let i = 0; i < ids.length; i += STAGED_LOOKUP_CHUNK) {
		const slice = ids.slice(i, i + STAGED_LOOKUP_CHUNK);
		const { data, error } = await withRetry(
			() => newSupabase.from('staged_companylogo').select('id, logo_url').in('id', slice),
			'fetchExistingStagedCompanyLogo'
		);
		if (error) throw error;
		for (const row of data || []) m.set(row.id, row);
	}
	return m;
}

async function upsertStagedCompanyLogo(row) {
	const { error } = await withRetry(
		() => newSupabase.from('staged_companylogo').upsert(row, { onConflict: 'id' }),
		'upsertStagedCompanyLogo'
	);
	if (error) throw error;
}

async function processCompany(company) {
	if (!company || !company.logo_url) return null;
	const info = extractBucketAndPathFromUrl(company.logo_url);
	if (!info) return null;
	try {
		const local = await downloadFromOld(info.bucket, info.path);
		const newUrl = await uploadToNew(info.bucket, info.path, local);
		await upsertStagedCompanyLogo({ id: company.id, logo_url: newUrl });
		return { id: company.id, logo_url: newUrl };
	} catch (e) {
		console.warn(`Skip company ${company.id} logo (bucket=${info.bucket}, path=${info.path}): ${e.message || e}`);
		return null;
	}
}

async function run() {
	console.log('Migrating company logos to NEW project and staging URLs');
	let offset = 0;
	let processed = 0;
	for (;;) {
		const companies = await fetchCompaniesBatch(offset, BATCH_SIZE);
		if (!companies || companies.length === 0) break;
		const ids = companies.map((c) => c.id);
		const existing = await fetchExistingStaged(ids);
		for (const c of companies) {
			const ex = existing.get(c.id);
			if (ex && ex.logo_url && String(ex.logo_url).trim() !== '') continue;
			await processCompany(c);
			processed += 1;
		}
		console.log(`Processed companies batch offset=${offset} size=${companies.length}`);
		offset += BATCH_SIZE;
		if (companies.length < BATCH_SIZE) break;
	}
	console.log(`Done. Processed ${processed} company logo(s).`);
}

if (require.main === module) {
	run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = {
	fetchCompaniesBatch,
	fetchExistingStaged,
	processCompany,
	run,
};



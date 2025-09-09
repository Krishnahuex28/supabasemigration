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
		try { return await fn(); } catch (err) {
			attempt += 1;
			if (attempt > RETRY_MAX) throw err;
			const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 100);
			console.warn(`Retry ${attempt}/${RETRY_MAX} after error in ${label}: ${err.message || err}`);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

async function fetchNewProfileIdsBatch(offset, limit) {
	const { data, error } = await withRetry(
		() => newSupabase
			.from('profiles')
			.select('id')
			.order('id', { ascending: true })
			.range(offset, offset + limit - 1),
		'fetchNewProfileIdsBatch'
	);
	if (error) throw error;
	return (data || []).map((r) => r.id);
}

async function fetchOldCreatedAtForIds(ids) {
	if (!ids || ids.length === 0) return new Map();
	const { data, error } = await withRetry(
		() => oldSupabase
			.from('profiles')
			.select('id, created_at')
			.in('id', ids),
		'fetchOldCreatedAtForIds'
	);
	if (error) throw error;
	const m = new Map();
	for (const row of data || []) m.set(row.id, row.created_at);
	return m;
}

async function upsertCreatedAtRows(rows) {
	if (!rows || rows.length === 0) return;
	const { error } = await withRetry(
		() => newSupabase.from('profiles').upsert(rows, { onConflict: 'id' }),
		'upsertCreatedAtRows'
	);
	if (error) throw error;
}

async function run() {
	console.log('Syncing profiles.created_at from OLD → NEW');
	let offset = 0;
	let total = 0;
	for (;;) {
		const ids = await fetchNewProfileIdsBatch(offset, BATCH_SIZE);
		if (!ids || ids.length === 0) break;
		const oldMap = await fetchOldCreatedAtForIds(ids);
		const rows = ids
			.map((id) => oldMap.get(id))
			.map((created_at, idx) => (created_at ? { id: ids[idx], created_at } : null))
			.filter(Boolean);
		if (rows.length) {
			await upsertCreatedAtRows(rows);
			total += rows.length;
		}
		console.log(`Processed offset=${offset} size=${ids.length}; updated ${rows.length}`);
		offset += BATCH_SIZE;
		if (ids.length < BATCH_SIZE) break;
	}
	console.log(`Done. Updated created_at for ${total} profile(s).`);
}

if (require.main === module) {
	run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = {
	setSupabaseClients,
	fetchNewProfileIdsBatch,
	fetchOldCreatedAtForIds,
	upsertCreatedAtRows,
	run,
};



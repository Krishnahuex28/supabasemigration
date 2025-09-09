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

const MEMBER_COLUMNS = [
	'id', 'company_id', 'user_id', 'role', 'created_at', 'first_name', 'last_name', 'phone', 'location',
	'terms_accepted', 'is_subscribed', 'avatar_url', 'updated_at', 'email'
];

function buildSelect(columns) {
	return columns.join(', ');
}

async function fetchOldCompanyMembersBatch(offset, limit) {
	const { data, error } = await withRetry(
		() => oldSupabase
			.from('company_members')
			.select(buildSelect(MEMBER_COLUMNS))
			.order('id', { ascending: true })
			.range(offset, offset + limit - 1),
		'fetchOldCompanyMembersBatch'
	);
	if (error) throw error;
	return data || [];
}

function mapMember(row) {
	const { avatar_url, ...rest } = row;
	return { ...rest, avatar_url: null };
}

async function upsertCompanyMembers(rows) {
	if (!rows || rows.length === 0) return;
	const { error } = await withRetry(
		() => newSupabase.from('company_members').upsert(rows, { onConflict: 'id' }),
		'upsertCompanyMembers'
	);
	if (error) throw error;
}

async function run() {
	console.log('Migrating company_members (avatar_url set to null)');
	let offset = 0;
	let total = 0;
	for (;;) {
		const batch = await fetchOldCompanyMembersBatch(offset, BATCH_SIZE);
		if (!batch || batch.length === 0) break;
		const rows = batch.map(mapMember);
		await upsertCompanyMembers(rows);
		total += rows.length;
		console.log(`Upserted ${rows.length} company_member rows (offset ${offset}).`);
		offset += BATCH_SIZE;
		if (batch.length < BATCH_SIZE) break;
	}
	console.log(`Done. Upserted ${total} company_member row(s).`);
}

if (require.main === module) {
	run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = {
	setSupabaseClients,
	fetchOldCompanyMembersBatch,
	mapMember,
	upsertCompanyMembers,
	run,
};



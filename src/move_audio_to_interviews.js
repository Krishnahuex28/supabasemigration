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

async function fetchStagedAudioBatch(offset, limit) {
	const { data, error } = await withRetry(
		() => newSupabase
			.from('stagedaudio')
			.select('id, wav_file_url, user_id')
			.order('id', { ascending: true })
			.range(offset, offset + limit - 1),
		'fetchStagedAudioBatch'
	);
	if (error) throw error;
	return data || [];
}

async function fetchOldTranscriptionsByIds(ids) {
	const map = new Map();
	if (!ids || ids.length === 0) return map;
	for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
		const slice = ids.slice(i, i + LOOKUP_CHUNK);
		const { data, error } = await withRetry(
			() => oldSupabase
				.from('interviews')
				.select('id, transcribed_data')
				.in('id', slice),
			'fetchOldTranscriptionsByIds'
		);
		if (error) throw error;
		for (const row of data || []) map.set(row.id, row.transcribed_data ?? null);
	}
	return map;
}

async function upsertInterviews(rows) {
	if (!rows || rows.length === 0) return;
	const { error } = await withRetry(
		() => newSupabase.from('interviews').upsert(rows, { onConflict: 'id' }),
		'upsertInterviews'
	);
	if (error) throw error;
}

async function run() {
	console.log('Moving stagedaudio → interviews');
	let offset = 0;
	let total = 0;
	for (;;) {
		const staged = await fetchStagedAudioBatch(offset, BATCH_SIZE);
		if (!staged || staged.length === 0) break;
		const ids = staged.map((r) => r.id);
		const transcriptions = await fetchOldTranscriptionsByIds(ids);
		const rows = staged.map((r) => ({
			id: r.id,
			wav_file_url: r.wav_file_url || null,
			user_id: r.user_id || null,
			transcribed_data: transcriptions.get(r.id) ?? null,
		}));
		await upsertInterviews(rows);
		total += rows.length;
		console.log(`Upserted ${rows.length} interviews (offset ${offset}).`);
		offset += BATCH_SIZE;
		if (staged.length < BATCH_SIZE) break;
	}
	console.log(`Done. Upserted ${total} interview row(s).`);
}

if (require.main === module) {
	run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = {
	setSupabaseClients,
	fetchStagedAudioBatch,
	fetchOldTranscriptionsByIds,
	upsertInterviews,
	run,
};



'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { extractBucketAndPathFromUrl } = require('./utils/url');
const { downloadFromOld, uploadToNew, setSupabaseClients } = require('./migrate_storage');

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
			console.warn(`Retry ${attempt}/${RETRY_MAX} after error in ${label}: ${err.message}. Waiting ${delay}ms...`);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

async function fetchLKProfileIdsBatch(offset, limit) {
	const { data, error } = await withRetry(
		() =>
			oldSupabase
				.from('profiles')
				.select('id')
				.eq('country', COUNTRY_FILTER)
				.order('id', { ascending: true })
				.range(offset, offset + limit - 1),
		'fetchLKProfileIdsBatch'
	);
	if (error) throw error;
	return (data || []).map((r) => r.id);
}

async function fetchInterviewsForUserIds(userIds) {
	if (!userIds || userIds.length === 0) return [];
	const { data, error } = await withRetry(
		() => oldSupabase.from('interviews').select('id, user_id, wav_file_url').in('user_id', userIds).order('id', { ascending: true }),
		'fetchInterviewsForUserIds'
	);
	if (error) throw error;
	return data || [];
}

const STAGED_LOOKUP_CHUNK = Number(process.env.STAGED_LOOKUP_CHUNK || 200);

async function fetchExistingStagedAudio(ids) {
	if (!ids || ids.length === 0) return new Map();
	const m = new Map();
	for (let i = 0; i < ids.length; i += STAGED_LOOKUP_CHUNK) {
		const slice = ids.slice(i, i + STAGED_LOOKUP_CHUNK);
		const { data, error } = await withRetry(
			() => newSupabase.from('stagedaudio').select('id, wav_file_url').in('id', slice),
			'fetchExistingStagedAudio'
		);
		if (error) throw error;
		for (const row of data || []) m.set(row.id, row);
	}
	return m;
}

async function upsertStagedAudio(row) {
	const { error } = await withRetry(
		() => newSupabase.from('stagedaudio').upsert(row, { onConflict: 'id' }),
		'upsertStagedAudio'
	);
	if (error) throw error;
}

function safeErrorMessage(err) {
	if (!err) return 'Unknown error';
	if (typeof err === 'string') return err;
	if (err.message && typeof err.message === 'string') return err.message;
	try { return JSON.stringify(err); } catch (_e) { return String(err); }
}

async function processInterview(interview) {
	if (!interview || !interview.wav_file_url) return null;
	const info = extractBucketAndPathFromUrl(interview.wav_file_url);
	if (!info) return null;
	try {
		const local = await downloadFromOld(info.bucket, info.path);
		const newUrl = await uploadToNew(info.bucket, info.path, local);
		await upsertStagedAudio({ id: interview.id, wav_file_url: newUrl, user_id: interview.user_id });
		return { id: interview.id, user_id: interview.user_id, wav_file_url: newUrl };
	} catch (e) {
		const msg = safeErrorMessage(e);
		console.warn(`Skip interview ${interview.id} (bucket=${info.bucket}, path=${info.path}): ${msg}`);
		return null;
	}
}

async function run() {
	console.log(`Migrating audio for profiles country=${COUNTRY_FILTER}`);
	let offset = 0;
	let totalProfiles = 0;
	let processed = 0;
	const skipped = [];
	for (;;) {
		const chunk = await fetchLKProfileIdsBatch(offset, BATCH_SIZE);
		if (!chunk || chunk.length === 0) break;
		totalProfiles += chunk.length;
		const interviews = await fetchInterviewsForUserIds(chunk);
		if (interviews.length) {
			const existing = await fetchExistingStagedAudio(interviews.map((r) => r.id));
			for (const it of interviews) {
				const ex = existing.get(it.id);
				if (ex && ex.wav_file_url && String(ex.wav_file_url).trim() !== '') continue;
				const result = await processInterview(it);
				if (!result) skipped.push(it.id);
				processed += 1;
			}
		}
		console.log(`Processed interviews for profiles offset=${offset} size=${chunk.length}`);
		offset += BATCH_SIZE;
		if (chunk.length < BATCH_SIZE) break;
	}
	console.log(`Done. Visited ${totalProfiles} profiles; processed ${processed} interview(s).`);
	if (skipped.length) {
		console.log(`Skipped ${skipped.length} interview(s): ${JSON.stringify(skipped)}`);
	}
}

if (require.main === module) {
	run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = {
	withRetry,
	fetchLKProfileIdsBatch,
	fetchInterviewsForUserIds,
	fetchExistingStagedAudio,
	processInterview,
	run,
};



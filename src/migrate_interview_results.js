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

async function fetchOldInterviewResultsByUserIds(userIds) {
	const rows = [];
	if (!userIds || userIds.length === 0) return rows;
	for (let i = 0; i < userIds.length; i += LOOKUP_CHUNK) {
		const slice = userIds.slice(i, i + LOOKUP_CHUNK);
		const { data, error } = await withRetry(
			() => oldSupabase
				.from('interview_results')
				.select('id, user_id, technical_assessment, strengths, areas_for_improvement, final_score, recommendation, interview_date, primary_skill, job_title, created_at, assessment_id')
				.in('user_id', slice),
			'fetchOldInterviewResultsByUserIds'
		);
		if (error) throw error;
		rows.push(...(data || []));
	}
	return rows;
}

async function insertInterviewResults(rows) {
	if (!rows || rows.length === 0) return;
	// Preserve IDs and created_at. Ignore duplicates on id.
	const { error } = await withRetry(
		() => newSupabase.from('interview_results').insert(rows, { onConflict: 'id', ignoreDuplicates: true }),
		'insertInterviewResults'
	);
	if (error) throw error;
}

async function run() {
	console.log('Migrating interview_results for existing NEW profiles');
	let offset = 0;
	let totalProfiles = 0;
	let totalInserted = 0;
	for (;;) {
		const ids = await fetchNewProfileIdsBatch(offset, BATCH_SIZE);
		if (!ids || ids.length === 0) break;
		totalProfiles += ids.length;
		const oldRows = await fetchOldInterviewResultsByUserIds(ids);
		if (oldRows.length) {
			await insertInterviewResults(oldRows);
			totalInserted += oldRows.length;
		}
		console.log(`Processed NEW profiles offset=${offset} size=${ids.length}; inserted ${oldRows.length}`);
		offset += BATCH_SIZE;
		if (ids.length < BATCH_SIZE) break;
	}
	console.log(`Done. Visited ${totalProfiles} profile(s); inserted ${totalInserted} interview_result row(s).`);
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
	fetchOldInterviewResultsByUserIds,
	insertInterviewResults,
	run,
};



'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const NEW_SUPABASE_URL = process.env.NEW_SUPABASE_URL;
const NEW_SUPABASE_KEY = process.env.NEW_SUPABASE_KEY;
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 200);
const RETRY_MAX = Number(process.env.RETRY_MAX || 5);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 500);

if (require.main === module) {
	if (!NEW_SUPABASE_URL || !NEW_SUPABASE_KEY) {
		console.error('Missing NEW_SUPABASE_URL/NEW_SUPABASE_KEY');
		process.exit(1);
	}
}

let supabase = createClient(NEW_SUPABASE_URL, NEW_SUPABASE_KEY);

function setSupabaseClient(client) {
	supabase = client;
}

async function withRetry(fn, label) {
	let attempt = 0;
	for (;;) {
		try { return await fn(); } catch (err) {
			attempt += 1;
			if (attempt > RETRY_MAX) throw err;
			const delay = RETRY_BASEMS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 100);
			console.warn(`Retry ${attempt}/${RETRY_MAX} after error in ${label}: ${err.message || err}`);
			await new Promise(r => setTimeout(r, delay));
		}
	}
}

function defaultBoards(companyId, jobId) {
	return [
		{ company_id: companyId, job_id: jobId, title: 'SHORTLISTED', pipeline_status: 'shortlisted', display_order: 0 },
		{ company_id: companyId, job_id: jobId, title: 'AI INTERVIEW ASSIGNED', pipeline_status: 'ai_interview_assigned', display_order: 1 },
		{ company_id: companyId, job_id: jobId, title: 'AI INTERVIEW COMPLETED', pipeline_status: 'ai_interview_completed', display_order: 2 },
		{ company_id: companyId, job_id: jobId, title: 'AI INTERVIEW EXPIRED', pipeline_status: 'ai_interview_expired', display_order: 3 },
		{ company_id: companyId, job_id: jobId, title: 'HUMAN INTERVIEW ASSIGNED', pipeline_status: 'human_interview_assigned', display_order: 4 },
		{ company_id: companyId, job_id: jobId, title: 'HUMAN INTERVIEW COMPLETED', pipeline_status: 'human_interview_completed', display_order: 5 },
		{ company_id: companyId, job_id: jobId, title: 'OFFER DISCUSSION', pipeline_status: 'offer_discussion', display_order: 6 },
		{ company_id: companyId, job_id: jobId, title: 'HIRED', pipeline_status: 'hired', display_order: 7 },
		{ company_id: companyId, job_id: jobId, title: 'REJECTED', pipeline_status: 'rejected', display_order: 8 },
	];
}

async function fetchJobsBatch(offset, limit) {
	const { data, error } = await withRetry(
		() => supabase.from('jobs').select('id, company_id').order('id', { ascending: true }).range(offset, offset + limit - 1),
		'fetchJobsBatch'
	);
	if (error) throw error;
	return data || [];
}

async function hasAnyBoards(jobId) {
	const { data, error } = await withRetry(
		() => supabase.from('company_boards').select('id', { count: 'exact', head: true }).eq('job_id', jobId),
		'hasAnyBoards'
	);
	if (error) throw error;
	// head: true returns no data, but count is on response; supabase-js v2 returns count on response as .count (not in data)
	// To avoid ambiguity, do a lightweight select limited to 1
	const { data: rows, error: e2 } = await supabase.from('company_boards').select('id').eq('job_id', jobId).limit(1);
	if (e2) throw e2;
	return (rows && rows.length > 0);
}

async function insertBoards(rows) {
	if (!rows || rows.length === 0) return;
	const { error } = await withRetry(
		() => supabase.from('company_boards').insert(rows),
		'insertBoards'
	);
	if (error) throw error;
}

async function run() {
	console.log('Initializing default company boards for existing jobs');
	let offset = 0;
	let totalJobs = 0;
	let totalInserted = 0;
	for (;;) {
		const jobs = await fetchJobsBatch(offset, BATCH_SIZE);
		if (!jobs || jobs.length === 0) break;
		for (const job of jobs) {
			if (!job || !job.id || !job.company_id) continue;
			const exists = await hasAnyBoards(job.id);
			if (exists) continue;
			const rows = defaultBoards(job.company_id, job.id);
			await insertBoards(rows);
			totalInserted += rows.length;
		}
		totalJobs += jobs.length;
		console.log(`Processed jobs offset=${offset} size=${jobs.length}`);
		offset += BATCH_SIZE;
		if (jobs.length < BATCH_SIZE) break;
	}
	console.log(`Done. Visited ${totalJobs} job(s); inserted ${totalInserted} board row(s).`);
}

if (require.main === module) {
	run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = {
	setSupabaseClient,
	defaultBoards,
	fetchJobsBatch,
	hasAnyBoards,
	insertBoards,
	run,
};



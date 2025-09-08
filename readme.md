# Supabase Storage Migration (Old → New Project)

This project migrates storage objects (resumes, profile pictures) from an OLD Supabase project to a NEW one and prints the updated URLs for use when inserting/updating rows in the new database.

Workflow:
- Download files pointed to by `public.profiles.resume_url` and `public.profiles.avatar_url` from the OLD project
- Upload to the NEW project in the same `bucket/objectPath`
- Output JSON per profile with new URL(s)

Note: Only the storage + URL rewrite is automated here. Updating database rows is a separate step you run after verifying the printed mappings.

## What’s included
- `src/migrate_storage.js`: migrate storage objects for profiles filtered by country
- `src/utils/url.js`: parse old public URLs and build new public URLs
- `src/index.js`: orchestrator entry
- `src/test/`: unit tests with 90%+ coverage thresholds (Vitest)
- `20250627182003_full_dump.sql`: schema/policies context

## Requirements
- Node.js 18+
- Supabase URL and service-role keys for both projects
- Buckets existing in NEW project (e.g., `resumes`, `talentprofilepictures`)

## Environment variables
Create `.env`:
```
OLD_SUPABASE_URL=https://<old-project-ref>.supabase.co
OLD_SUPABASE_KEY=<old-service-role-key>
NEW_SUPABASE_URL=https://<new-project-ref>.supabase.co
NEW_SUPABASE_KEY=<new-service-role-key>

# Optional
COUNTRY_FILTER=Sri Lanka   # default: LK
DOWNLOAD_DIR=tmp           # local cache dir
AVATAR_BUCKET=talentprofilepictures # bucket for data: avatar uploads
RETRY_MAX=5                # max retries on transient failures
RETRY_BASE_MS=500          # initial backoff in ms
AVATAR_MAX_BYTES=5000000   # compress avatars over this size (bytes)
AVATAR_MAX_DIM=1024        # max width/height during compression
BATCH_SIZE=200             # profiles processed per batch to avoid timeouts
```
- `COUNTRY_FILTER` must match `public.profiles.country` values exactly.

## Install
```
npm install
```

## Ensure buckets exist in NEW project
Create buckets referenced by your data. Ensure storage policies permit uploads with the service key.

Also create the helper table in NEW project to capture migrated URLs per user:
```
create table public.stagedbuckets (
  user_id uuid not null default auth.uid(),
  created_at timestamp with time zone not null default now(),
  resume_url text null default ''::text,
  avatar_url text null,
  constraint stagedbuckets_pkey primary key (user_id)
);
```

## Run storage migration
```
npm run migrate:storage
```
The script processes profiles in batches (`BATCH_SIZE`) to avoid DB statement timeouts and retries transient errors with exponential backoff.
Example output:
```
{"id":"<profile-uuid>","updated":{"resume_url":"https://<new>.supabase.co/storage/v1/object/public/resumes/<uid>/resume.pdf","avatar_url":"https://<new>.supabase.co/storage/v1/object/public/talentprofilepictures/<uid>/avatar.jpg"}}
```
Use these URLs when inserting/updating rows in the NEW project.

The script also upserts into `public.stagedbuckets` in the NEW project for each profile processed, ensuring `user_id` has the latest `resume_url`/`avatar_url`.

## Tests
Run unit tests with coverage (≥90% branches):
```
npm run test
```
Add new tests under `src/test`. For future E2E, prefer Cypress and reference elements by IDs.

## Scope & limitations
- Public URL parsing expects: `https://<ref>.supabase.co/storage/v1/object/public/<bucket>/<object>`
- Private files download requires proper privileges on the old project
- Data URLs like `data:image/png;base64,...` are supported for `avatar_url`
  - The script detects `data:` avatars, decodes them, uploads to `${AVATAR_BUCKET}/<profile-id>/avatar.<ext>` and outputs the new public URL
  - If the decoded avatar exceeds `AVATAR_MAX_BYTES`, it is resized/encoded (preferring WebP/JPEG) to stay under the limit
- Script does not write to the database; apply the printed mappings when you import/update rows

## Troubleshooting
- 404 on download: validate path exists in OLD storage
- 401/403: confirm keys and service role usage
- Upload errors: ensure NEW buckets exist and allow inserts
- No profiles found: verify `COUNTRY_FILTER`
- Intermittent 52x/connection issues: the script retries with exponential backoff. Tune `RETRY_MAX` and `RETRY_BASE_MS` as needed

## Roadmap
- Support `data:` avatars (decode + upload + URL update)
- Add DB row migration utilities (insert order, dependencies)
- Add Cypress E2E smoke tests and integration tests with mocked Supabase clients

--TYPES--TYPES--TYPES--TYPES--TYPES--TYPES--TYPES--TYPES--TYPES--TYPES--TYPES--

CREATE TYPE "public"."offer_status" AS ENUM (
    'pending',
    'accepted',
    'rejected'
);

--FUNCTIONS--FUNCTIONS--FUNCTIONS--FUNCTIONS--FUNCTIONS--FUNCTIONS--FUNCTIONS--FUNCTIONS--FUNCTIONS--FUNCTIONS--

-- Generic update timestamp function for all tables
CREATE OR REPLACE FUNCTION public.update_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_user_id_by_email"("p_email" "text") RETURNS TABLE("id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN QUERY SELECT au.id FROM auth.users au WHERE au.email = p_email;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_user_id_by_phone"("p_phone" "text") RETURNS TABLE("id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN QUERY 
    SELECT au.id 
    FROM auth.users au 
    WHERE au.raw_user_meta_data->>'phone' = p_phone;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."check_email_in_company_members"("p_email" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
    BEGIN
      RETURN EXISTS (SELECT 1 FROM public.company_members WHERE email = p_email);
    END;
    $$;

CREATE OR REPLACE FUNCTION "public"."check_phone_in_company_members"("p_phone" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
    BEGIN
      RETURN EXISTS (SELECT 1 FROM public.company_members WHERE phone = p_phone);
    END;
    $$;

-- Create BEFORE INSERT function that modifies NEW row directly
CREATE OR REPLACE FUNCTION public.mark_companyemail_confirmed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  -- If a company user is being created, mark email as confirmed inline
  IF (NEW.raw_user_meta_data->>'role') = 'company' THEN
    NEW.email_confirmed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_role_display_name"("role_key" "text") RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    RETURN CASE role_key
        WHEN 'aiengineer' THEN 'AI Engineer'
        WHEN 'airesearcher' THEN 'AI Researcher'
        WHEN 'automation' THEN 'Automation Engineer'
        WHEN 'backend' THEN 'Backend Developer'
        WHEN 'computervision' THEN 'Computer Vision Engineer'
        WHEN 'dataengineer' THEN 'Data Engineer'
        WHEN 'datascientist' THEN 'Data Scientist'
        WHEN 'devops' THEN 'DevOps Engineer'
        WHEN 'embedded' THEN 'Embedded Systems Engineer'
        WHEN 'frontend' THEN 'Frontend Developer'
        WHEN 'fullstack' THEN 'Full Stack Developer'
        WHEN 'game' THEN 'Game Developer'
        WHEN 'ml' THEN 'Machine Learning Engineer'
        WHEN 'mobile' THEN 'Mobile App Developer'
        WHEN 'nlp' THEN 'NLP Engineer'
        WHEN 'qa' THEN 'QA Engineer / Test Engineer'
        WHEN 'sre' THEN 'Site Reliability Engineer (SRE)'
        WHEN 'softwareengineer' THEN 'Software Engineer'
        WHEN 'solutionsarchitect' THEN 'Solutions Architect'
        WHEN 'solutionsengineer' THEN 'Solutions Engineer'
        WHEN 'uiengineer' THEN 'UI Engineer'
        ELSE role_key -- Fallback to the key itself if not found
    END;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."handle_interview_events"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$DECLARE
    -- Variable declarations (same as before)
    candidate_user_id UUID;
    candidate_first_name TEXT;
    candidate_last_name TEXT;
    candidate_full_name TEXT;
    target_company_id UUID;
    company_name_for_candidate TEXT;
    job_role_key TEXT;
    job_role_display_name TEXT;
    interview_type_for_candidate TEXT;
    notification_message TEXT;
    notification_link TEXT;
    client_user_record RECORD;
BEGIN
    RAISE NOTICE '[Interview Trigger] Fired for operation: %, status: %', TG_OP, NEW.status;

    SELECT
        cjp.profile_id, p.first_name, p.last_name, j.company_id, j.roles, c.name
    INTO
        candidate_user_id, candidate_first_name, candidate_last_name, target_company_id, job_role_key, company_name_for_candidate
    FROM public.candidate_job_pipeline AS cjp
    JOIN public.jobs AS j ON cjp.job_id = j.id
    JOIN public.companies AS c ON j.company_id = c.id
    JOIN public.profiles AS p ON cjp.profile_id = p.id
    WHERE cjp.id = NEW.candidate_pipeline_id;

    RAISE NOTICE '[Interview Trigger] Fetched candidate_user_id: % for pipeline_id: %', candidate_user_id, NEW.candidate_pipeline_id;

    job_role_display_name := get_role_display_name(job_role_key);

    -- Scenario 1: Notify CANDIDATE on new interview
    IF (TG_OP = 'INSERT' AND NEW.status = 'scheduled') OR
       (TG_OP = 'UPDATE' AND NEW.status = 'scheduled' AND OLD.status <> 'scheduled') THEN

        RAISE NOTICE '[Interview Trigger] Entered Scenario 1 for candidate notification.';
        IF candidate_user_id IS NOT NULL THEN
            interview_type_for_candidate := COALESCE(NULLIF(TRIM(NEW.interview_type), ''), 'general');
            notification_message := 'You have been invited for an interview for the ' || interview_type_for_candidate ||
                                    ' stage at ' || COALESCE(company_name_for_candidate, 'a company') || ' for the ' || COALESCE(job_role_display_name, 'a role') || ' position!';
            notification_link := '/calendar';

            RAISE NOTICE '[Interview Trigger] Preparing to insert notification for user: %', candidate_user_id;
            INSERT INTO public.notifications (user_id, message, link)
            VALUES (candidate_user_id, notification_message, notification_link);
            RAISE NOTICE '[Interview Trigger] Successfully inserted notification for candidate.';
        ELSE
            RAISE NOTICE '[Interview Trigger] SKIPPED candidate notification: candidate_user_id is NULL.';
        END IF;
    END IF;

    -- Scenario 2: Notify CLIENT(s) on candidate status update
    IF TG_OP = 'UPDATE' AND NEW.status IN ('accepted', 'declined', 'request_reschedule') AND NEW.status <> OLD.status THEN
        RAISE NOTICE '[Interview Trigger] Entered Scenario 2 for client notification.';
        IF target_company_id IS NOT NULL THEN
            candidate_full_name := TRIM(BOTH ' ' FROM COALESCE(candidate_first_name, '') || ' ' || COALESCE(candidate_last_name, ''));
            CASE NEW.status
              WHEN 'accepted' THEN notification_message := COALESCE(NULLIF(candidate_full_name, ''), 'A candidate') || ' has accepted the interview for the ' || COALESCE(job_role_display_name, 'a job') || ' position.';
              WHEN 'declined' THEN notification_message := COALESCE(NULLIF(candidate_full_name, ''), 'A candidate') || ' has declined the interview for the ' || COALESCE(job_role_display_name, 'a job') || ' position.';
              WHEN 'request_reschedule' THEN notification_message := COALESCE(NULLIF(candidate_full_name, ''), 'A candidate') || ' has requested to reschedule the interview for the ' || COALESCE(job_role_display_name, 'a job') || ' position.';
              ELSE notification_message := 'A candidate has updated their interview status for ' || COALESCE(job_role_display_name, 'a job') || '.';
            END CASE;
            notification_link := '/hiring-board';
            FOR client_user_record IN SELECT cm.user_id FROM public.company_members cm WHERE cm.company_id = target_company_id AND cm.user_id IS NOT NULL LOOP
              INSERT INTO public.notifications (user_id, message, link) VALUES (client_user_record.user_id, notification_message, notification_link);
            END LOOP;
        END IF;
    END IF;

    IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
    EXCEPTION WHEN others THEN
        RAISE WARNING '[HANDLE_INTERVIEW_EVENTS_TRIGGER] - Error: %. SQLSTATE: %', SQLERRM, SQLSTATE;
        IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;$$;


--TABLES--TABLES--TABLES--TABLES--TABLES--TABLES--TABLES--TABLES--TABLES--TABLES--TABLES--TABLES--TABLES--

CREATE TABLE IF NOT EXISTS "public"."admins" (
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."candidate_job_offers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pipeline_id" "uuid" NOT NULL,
    "salary" numeric(12,2) NOT NULL,
    "salary_currency" character(3) DEFAULT 'USD'::"bpchar" NOT NULL,
    "start_date" "date" NOT NULL,
    "probation_period_months" integer NOT NULL,
    "job_title" "text" NOT NULL,
    "experience_level" "text" NOT NULL,
    "employment_type" "text" NOT NULL,
    "reports_to" "text" NOT NULL,
    "work_mode" "text" NOT NULL,
    "notes" "text",
    "status" "public"."offer_status" DEFAULT 'pending'::"public"."offer_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."candidate_job_pipeline" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'shortlisted'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "display_order" integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."companies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "logo_url" "text",
    "industry" "text",
    "country" "text",
    "website" "text",
    "referral_source" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "tech_stack" "text"[],
    "office_locations" "text"[],
    "benefits" "text"[],
    "workplace_culture" "text"[],
    "profile_bio" "text",
    "technology_stack" "jsonb" DEFAULT '[]'::"jsonb",
    "first_job_created" boolean DEFAULT false NOT NULL,
    "company_profile_completed" boolean DEFAULT false NOT NULL,
    "social_media" "jsonb" DEFAULT '[]'::"jsonb",
    "timezones" "jsonb" DEFAULT '[]'::"jsonb"
);

CREATE TABLE IF NOT EXISTS "public"."company_boards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "pipeline_status" "text" NOT NULL,
    "display_order" integer DEFAULT 0 NOT NULL,
    "job_id" "uuid" NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."company_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid",
    "user_id" "uuid",
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "first_name" "text",
    "last_name" "text",
    "phone" "text",
    "location" "text",
    "terms_accepted" boolean DEFAULT false,
    "is_subscribed" boolean DEFAULT false,
    "avatar_url" "text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "email" "text",
    CONSTRAINT "company_members_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'member'::"text"])))
);

CREATE TABLE IF NOT EXISTS "public"."interview_results" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "technical_assessment" "text" NOT NULL,
    "strengths" "text"[] NOT NULL,
    "areas_for_improvement" "text"[] NOT NULL,
    "final_score" numeric NOT NULL,
    "recommendation" "text" NOT NULL,
    "interview_date" timestamp with time zone DEFAULT "now"(),
    "primary_skill" "text",
    "job_title" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "assessment_id" numeric
);

CREATE TABLE IF NOT EXISTS "public"."interviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "wav_file_url" "text" NOT NULL,
    "transcribed_data" "json",
    "user_id" "uuid" NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."job_interviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "candidate_pipeline_id" "uuid" NOT NULL,
    "scheduled_at" timestamp with time zone NOT NULL,
    "duration_minutes" integer DEFAULT 30 NOT NULL,
    "interview_type" "text",
    "status" "text" DEFAULT '''scheduled''::text'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "platform" "text",
    "meeting_link" "text",
    "passcode" "text",
    "reschedule_reason" "text",
    "reschedule_requested_at" timestamp with time zone,
    "rescheduled_from" timestamp with time zone,
    "timezone" "text",
    CONSTRAINT "job_interviews_status_check" CHECK (("status" = ANY (ARRAY['scheduled'::"text", 'accepted'::"text", 'canceled'::"text", 'completed'::"text", 'request_reschedule'::"text"])))
);

CREATE TABLE IF NOT EXISTS "public"."jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid",
    "title" "text" NOT NULL,
    "description" "text" NOT NULL,
    "requirements" "text"[],
    "skills" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "salary_range" "numrange",
    "location" "text",
    "type" "text",
    "status" "text" DEFAULT 'draft'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "primary_skill" "text",
    "english_proficiency" "text",
    "years_experience" integer,
    "start_date" "date",
    "working_hours" "text",
    "what_you_expect" "text",
    "what_you_get" "text",
    "annual_take_home" numeric,
    "end_date" "date",
    "roles" "text",
    "location_type" "text",
    "what_candidate_get" numeric[],
    "annual_take_home_range" numeric[],
    "job_location" "text",
    "description_link" "text",
    "currency" "text",
    CONSTRAINT "jobs_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text", 'closed'::"text"]))),
    CONSTRAINT "jobs_type_check" CHECK (("type" = ANY (ARRAY['full-time'::"text", 'part-time'::"text", 'contract'::"text", 'internship'::"text"])))
);

CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "message" "text" NOT NULL,
    "link" "text",
    "is_read" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);

ALTER TABLE "public"."notifications" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."notifications_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."onboarding_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "first_name" "text" NOT NULL,
    "last_name" "text" NOT NULL,
    "linkedin_url" "text",
    "type" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "company_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "onboarding_completed" boolean DEFAULT false NOT NULL,
    "verification_url" "text",
    CONSTRAINT "onboarding_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"]))),
    CONSTRAINT "onboarding_requests_type_check" CHECK (("type" = ANY (ARRAY['candidate'::"text", 'company'::"text"])))
);

CREATE TABLE IF NOT EXISTS "public"."profile_availabilities" (
    "profile_id" "uuid" NOT NULL,
    "timeslots" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "timezone" "text"
);

CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "email" "text",
    "phone" "text",
    "avatar_url" "text",
    "role" "text",
    "job_title" "text",
    "primary_skill" "text",
    "years_of_experience" integer,
    "english_level" "text",
    "bio" "text",
    "expected_salary" numeric,
    "preferred_location" "text",
    "work_preference" "text",
    "notice_period" "text",
    "resume_url" "text",
    "onboarding_completed" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "resume_data" "jsonb",
    "work_experience" "jsonb" DEFAULT '[]'::"jsonb",
    "education_details" "jsonb" DEFAULT '[]'::"jsonb",
    "license_details" "jsonb" DEFAULT '[]'::"jsonb",
    "english_test_completed" boolean DEFAULT false,
    "coding_test_completed" boolean DEFAULT false,
    "final_interview_completed" boolean DEFAULT false,
    "description" "text",
    "ai_description" "text",
    "talent_profile_completed" boolean DEFAULT false NOT NULL,
    "skills" "jsonb" DEFAULT '[]'::"jsonb",
    "social_media" "jsonb" DEFAULT '{}'::"jsonb",
    "preferred_timezones" "jsonb" DEFAULT '[]'::"jsonb",
    "preferred_locations" "jsonb" DEFAULT '[]'::"jsonb",
    "work_preferences" "jsonb" DEFAULT '[]'::"jsonb",
    "level" "text",
    "country" "text" DEFAULT ''::"text",
    "project_detail" "jsonb"[],
    "why_create_account" "text",
    "company_preferences" "text"[],
    "interview_attempt_count" numeric DEFAULT '0'::numeric,
    "currency" text DEFAULT NULL,
    CONSTRAINT "profiles_why_create_account_check" CHECK (("length"("why_create_account") <= 200))
);

CREATE TABLE IF NOT EXISTS "public"."unauth_job_views" (
    "ip_address" "text" NOT NULL,
    "view_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."app_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key" "text" NOT NULL UNIQUE,
    "value" "text" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);

--TABLE PRIMARY KEYS--TABLE PRIMARY KEYS--TABLE PRIMARY KEYS--TABLE PRIMARY KEYS--TABLE PRIMARY KEYS--TABLE PRIMARY KEYS--

ALTER TABLE ONLY "public"."admins"
    ADD CONSTRAINT "admins_pkey" PRIMARY KEY ("user_id");

ALTER TABLE ONLY "public"."candidate_job_offers"
    ADD CONSTRAINT "candidate_job_offers_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."candidate_job_pipeline"
    ADD CONSTRAINT "candidate_job_pipeline_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."company_boards"
    ADD CONSTRAINT "company_boards_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."company_members"
    ADD CONSTRAINT "company_members_company_id_user_id_key" UNIQUE ("company_id", "user_id");

ALTER TABLE ONLY "public"."company_members"
    ADD CONSTRAINT "company_members_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."interview_results"
    ADD CONSTRAINT "interview_results_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."interviews"
    ADD CONSTRAINT "interviews_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."job_interviews"
    ADD CONSTRAINT "job_interviews_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."onboarding_requests"
    ADD CONSTRAINT "onboarding_requests_email_key" UNIQUE ("email");

ALTER TABLE ONLY "public"."onboarding_requests"
    ADD CONSTRAINT "onboarding_requests_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."profile_availabilities"
    ADD CONSTRAINT "profile_availabilities_pkey" PRIMARY KEY ("profile_id");

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."unauth_job_views"
    ADD CONSTRAINT "unauth_job_views_pkey" PRIMARY KEY ("ip_address");

ALTER TABLE "public"."app_settings" ADD CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id");


--INDEXES--INDEXES--INDEXES--INDEXES--INDEXES--INDEXES--INDEXES--INDEXES--INDEXES--INDEXES--INDEXES--INDEXES--

CREATE INDEX "company_boards_company_id_display_order_idx" ON "public"."company_boards" USING "btree" ("company_id", "display_order");
CREATE INDEX "idx_notifications_created_at" ON "public"."notifications" USING "btree" ("created_at" DESC);
CREATE INDEX "idx_notifications_user_id_is_read" ON "public"."notifications" USING "btree" ("user_id", "is_read");
CREATE INDEX "profile_availabilities_timeslots_idx" ON "public"."profile_availabilities" USING "gin" ("timeslots" "jsonb_path_ops");
CREATE INDEX "company_boards_job_id_idx" ON "public"."company_boards" USING "btree" ("job_id");
CREATE INDEX "app_settings_key_idx" ON "public"."app_settings" ("key"); 



--TRIGGERS--TRIGGERS--TRIGGERS--TRIGGERS--TRIGGERS--TRIGGERS--TRIGGERS--TRIGGERS--TRIGGERS--TRIGGERS--

CREATE OR REPLACE TRIGGER "trigger_handle_interview_events" AFTER INSERT OR UPDATE ON "public"."job_interviews" FOR EACH ROW EXECUTE FUNCTION "public"."handle_interview_events"();
COMMENT ON TRIGGER "trigger_handle_interview_events" ON "public"."job_interviews" IS 'Handles sending notifications to candidates and clients when an interview is created or its status is updated.';

-- Create BEFORE INSERT trigger on auth.users to invoke the function
CREATE TRIGGER company_auto_email_verification
BEFORE INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.mark_companyemail_confirmed();

-- Jobs
CREATE OR REPLACE TRIGGER job_update_timestamp
BEFORE UPDATE ON public.jobs
FOR EACH ROW
EXECUTE FUNCTION public.update_timestamp();

-- Companies
CREATE OR REPLACE TRIGGER company_update_timestamp
BEFORE UPDATE ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.update_timestamp();

-- Profiles
CREATE OR REPLACE TRIGGER profile_update_timestamp
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.update_timestamp();

-- Profile Availabilities
CREATE OR REPLACE TRIGGER profile_availabilities_update_timestamp
BEFORE UPDATE ON public.profile_availabilities
FOR EACH ROW
EXECUTE FUNCTION public.update_timestamp();

-- Candidate Job Pipeline
CREATE OR REPLACE TRIGGER candidate_job_pipeline_update_timestamp
BEFORE UPDATE ON public.candidate_job_pipeline
FOR EACH ROW
EXECUTE FUNCTION public.update_timestamp();

-- Candidate Job Offers
CREATE OR REPLACE TRIGGER candidate_job_offers_update_timestamp
BEFORE UPDATE ON public.candidate_job_offers
FOR EACH ROW
EXECUTE FUNCTION public.update_timestamp();

-- Job Interviews
CREATE OR REPLACE TRIGGER job_interviews_update_timestamp
BEFORE UPDATE ON public.job_interviews
FOR EACH ROW
EXECUTE FUNCTION public.update_timestamp();

--TABLE FOREIGN KEYS--TABLE FOREIGN KEYS--TABLE FOREIGN KEYS--TABLE FOREIGN KEYS--TABLE FOREIGN KEYS--

ALTER TABLE ONLY "public"."admins"
    ADD CONSTRAINT "admins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."candidate_job_offers"
    ADD CONSTRAINT "candidate_job_offers_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "public"."candidate_job_pipeline"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."candidate_job_pipeline"
    ADD CONSTRAINT "candidate_job_pipeline_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."candidate_job_pipeline"
    ADD CONSTRAINT "candidate_job_pipeline_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."company_boards"
    ADD CONSTRAINT "company_boards_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."company_members"
    ADD CONSTRAINT "company_members_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."company_members"
    ADD CONSTRAINT "company_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."interview_results"
    ADD CONSTRAINT "interview_results_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."job_interviews"
    ADD CONSTRAINT "job_interviews_candidate_pipeline_id_fkey" FOREIGN KEY ("candidate_pipeline_id") REFERENCES "public"."candidate_job_pipeline"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."profile_availabilities"
    ADD CONSTRAINT "profile_availabilities_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE "public"."company_boards" 
    ADD CONSTRAINT "company_boards_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;




--POLICIES--POLICIES--POLICIES--POLICIES--POLICIES--POLICIES--POLICIES--POLICIES--POLICIES--POLICIES--POLICIES--POLICIES--

--admin--
CREATE POLICY "Admins can see all admins"
ON public.admins
FOR SELECT
TO authenticated
USING (
  auth.uid() IN (SELECT user_id FROM public.admins)
);


--candidate_job_pipeline--
CREATE POLICY "Authenticated users can see all candidate_job_pipeline"
ON public.candidate_job_pipeline
FOR SELECT
TO authenticated
USING (
  true
);


CREATE POLICY "Allow DELETE for company members to own rows"
ON public.candidate_job_pipeline
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.jobs j
    JOIN public.company_members cm ON j.company_id = cm.company_id
    WHERE j.id = candidate_job_pipeline.job_id
      AND cm.user_id = auth.uid()
  )
);

CREATE POLICY "Allow INSERT for company members to own row"
ON public.candidate_job_pipeline
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.jobs j
    JOIN public.company_members cm ON j.company_id = cm.company_id
    WHERE j.id = candidate_job_pipeline.job_id
      AND cm.user_id = auth.uid()
  )
);

CREATE POLICY "Allow UPDATE for company members to own row"
ON public.candidate_job_pipeline
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.jobs j
    JOIN public.company_members cm ON j.company_id = cm.company_id
    WHERE j.id = candidate_job_pipeline.job_id
      AND cm.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.jobs j
    JOIN public.company_members cm ON j.company_id = cm.company_id
    WHERE j.id = candidate_job_pipeline.job_id
      AND cm.user_id = auth.uid()
  )
);

CREATE POLICY "Allow Talents to update own row"
ON public.candidate_job_pipeline
FOR UPDATE
TO authenticated
USING (
  profile_id = auth.uid()
)
WITH CHECK (
  profile_id = auth.uid()
);


--Jobs--
CREATE POLICY "Anyone can view jobs"
ON public.jobs
FOR SELECT
TO public
USING (true);    


CREATE POLICY "company_members_can_insert_own_company_jobs"
ON public.jobs
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = public.jobs.company_id
      AND cm.user_id = auth.uid()
  )
);


CREATE POLICY "company_members_can_update_own_company_jobs"
ON public.jobs
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = jobs.company_id
      AND cm.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = jobs.company_id
      AND cm.user_id = auth.uid()
  )
);

CREATE POLICY "company_members_can_delete_own_company_jobs"
ON public.jobs
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = jobs.company_id
      AND cm.user_id = auth.uid()
  )
);


--candidate_job_offers--
CREATE POLICY "Authenticated users can view all job offers"
ON public.candidate_job_offers
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Company members can insert own company job offers"
ON public.candidate_job_offers
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.candidate_job_pipeline cjp
    JOIN public.jobs j ON cjp.job_id = j.id
    JOIN public.company_members cm ON j.company_id = cm.company_id
    WHERE cjp.id = candidate_job_offers.pipeline_id
      AND cm.user_id = auth.uid()
  )
);

CREATE POLICY "Company members can update own company job offers"
ON public.candidate_job_offers
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.candidate_job_pipeline cjp
    JOIN public.jobs j ON cjp.job_id = j.id
    JOIN public.company_members cm ON j.company_id = cm.company_id
    WHERE cjp.id = candidate_job_offers.pipeline_id
      AND cm.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.candidate_job_pipeline cjp
    JOIN public.jobs j ON cjp.job_id = j.id
    JOIN public.company_members cm ON j.company_id = cm.company_id
    WHERE cjp.id = candidate_job_offers.pipeline_id
      AND cm.user_id = auth.uid()
  )
);

CREATE POLICY "Company members can delete own company job offers"
ON public.candidate_job_offers
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.candidate_job_pipeline cjp
    JOIN public.jobs j ON cjp.job_id = j.id
    JOIN public.company_members cm ON j.company_id = cm.company_id
    WHERE cjp.id = candidate_job_offers.pipeline_id
      AND cm.user_id = auth.uid()
  )
);

CREATE POLICY "Talent can update own job offer"
ON public.candidate_job_offers
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.candidate_job_pipeline cjp
    WHERE cjp.id = candidate_job_offers.pipeline_id
      AND cjp.profile_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.candidate_job_pipeline cjp
    WHERE cjp.id = candidate_job_offers.pipeline_id
      AND cjp.profile_id = auth.uid()
  )
);




--company_members--
CREATE POLICY "Company members can create their own companymembers"
ON public.company_members
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.uid()
);

CREATE POLICY "Company members can update own row"
ON public.company_members
FOR UPDATE
TO authenticated
USING (
  user_id = auth.uid()
)
WITH CHECK (
  user_id = auth.uid()
);

CREATE POLICY "Company members can delete own row"
ON public.company_members
FOR DELETE
TO authenticated
USING (
  user_id = auth.uid()
);

CREATE POLICY "Anyone can view company_members"
ON public.company_members
FOR SELECT
TO public
USING (true);


--Notifications--
CREATE POLICY "Users can read their own notifications"
ON public.notifications
FOR SELECT
TO authenticated
USING (
    auth.uid() = user_id
);

CREATE POLICY "Users can update their own notifications"
ON public.notifications
FOR UPDATE
TO authenticated
USING (
    auth.uid() = user_id
)
WITH CHECK (
    auth.uid() = user_id
);


--Companies--
CREATE POLICY "Anyone can view companies"
ON public.companies
FOR SELECT
TO public
USING (true);

CREATE POLICY "Companies - Insert by creator"
ON public.companies
FOR INSERT
TO authenticated
WITH CHECK (
  created_by = auth.uid()
);

CREATE POLICY "Companymeners can update their Companies"
ON public.companies
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = companies.id
      AND cm.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = companies.id
      AND cm.user_id = auth.uid()
  )
);

CREATE POLICY "Company members can delete their company"
ON public.companies
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = companies.id
      AND cm.user_id = auth.uid()
  )
);

--Profiles--
CREATE POLICY "Anyone can view profiles"
ON public.profiles
FOR SELECT
TO public
USING (true);


CREATE POLICY "Users can insert their own profile" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK (true);
CREATE POLICY "Users can update their own profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "id"));

--unauth_job_views--
CREATE POLICY "allow_anon_insert" ON "public"."unauth_job_views" FOR INSERT TO "anon" WITH CHECK (true);
CREATE POLICY "allow_anon_select" ON "public"."unauth_job_views" FOR SELECT TO "anon" USING (true);
CREATE POLICY "allow_anon_update" ON "public"."unauth_job_views" FOR UPDATE TO "anon" USING (true) WITH CHECK (true);

--company_boards--
CREATE POLICY "Company members can insert own company boards"
ON public.company_boards
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = company_boards.company_id
      AND cm.user_id = auth.uid()
  )
);

CREATE POLICY "Company members can update own company boards"
ON public.company_boards
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = company_boards.company_id
      AND cm.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = company_boards.company_id
      AND cm.user_id = auth.uid()
  )
);

CREATE POLICY "Company members can delete own company boards"
ON public.company_boards
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = company_boards.company_id
      AND cm.user_id = auth.uid()
  )
);

CREATE POLICY "Authenticated users can view all company boards"
ON public.company_boards
FOR SELECT
TO authenticated
USING (true);

--Job_interviews--
CREATE POLICY "Authenticated users can view all job interviews"
ON public.job_interviews
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Company members can insert own company job interviews"
ON public.job_interviews
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.candidate_job_pipeline cjp
    JOIN public.jobs j ON cjp.job_id = j.id
    JOIN public.company_members cm ON j.company_id = cm.company_id
    WHERE cjp.id = job_interviews.candidate_pipeline_id
      AND cm.user_id = auth.uid()
  )
);

CREATE POLICY "Company members can update own company job interviews"
ON public.job_interviews
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.candidate_job_pipeline cjp
    JOIN public.jobs j ON cjp.job_id = j.id
    JOIN public.company_members cm ON j.company_id = cm.company_id
    WHERE cjp.id = job_interviews.candidate_pipeline_id
      AND cm.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.candidate_job_pipeline cjp
    JOIN public.jobs j ON cjp.job_id = j.id
    JOIN public.company_members cm ON j.company_id = cm.company_id
    WHERE cjp.id = job_interviews.candidate_pipeline_id
      AND cm.user_id = auth.uid()
  )
);

CREATE POLICY "Company members can delete own company job interviews"
ON public.job_interviews
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.candidate_job_pipeline cjp
    JOIN public.jobs j ON cjp.job_id = j.id
    JOIN public.company_members cm ON j.company_id = cm.company_id
    WHERE cjp.id = job_interviews.candidate_pipeline_id
      AND cm.user_id = auth.uid()
  )
);

CREATE POLICY "Talent can update own interview"
ON public.job_interviews
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.candidate_job_pipeline cjp
    WHERE cjp.id = job_interviews.candidate_pipeline_id
      AND cjp.profile_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.candidate_job_pipeline cjp
    WHERE cjp.id = job_interviews.candidate_pipeline_id
      AND cjp.profile_id = auth.uid()
  )
);


--profile_availabilities--

-- SELECT (view) their own rows
CREATE POLICY "Users can view their own availability"
ON public.profile_availabilities
FOR SELECT
TO authenticated
USING (auth.uid() = profile_id);

-- INSERT (add) their own row
CREATE POLICY "Users can insert their own availability"
ON public.profile_availabilities
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = profile_id);

-- UPDATE (edit) their own row
CREATE POLICY "Users can update their own availability"
ON public.profile_availabilities
FOR UPDATE
TO authenticated
USING (auth.uid() = profile_id)
WITH CHECK (auth.uid() = profile_id);

-- DELETE (remove) their own row
CREATE POLICY "Users can delete their own availability"
ON public.profile_availabilities
FOR DELETE
TO authenticated
USING (auth.uid() = profile_id);

CREATE POLICY "Company members can view all availabilities"
ON public.profile_availabilities
FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1
        FROM company_members cm
        WHERE cm.user_id = auth.uid()
    )
);


--app_settings--
CREATE POLICY "Allow authenticated users to read app settings"
ON public.app_settings
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Admins can update app settings"
ON public.app_settings
FOR UPDATE
TO authenticated
USING (
  auth.uid() IN (SELECT user_id FROM public.admins)
)
WITH CHECK (
  auth.uid() IN (SELECT user_id FROM public.admins)
);

--interview_results--
CREATE POLICY "Talents can insert own interview results"
ON public.interview_results
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.uid()
);

CREATE POLICY "Talents can update own interview results"
ON public.interview_results
FOR UPDATE
TO authenticated
USING (
  user_id = auth.uid()
)
WITH CHECK (
  user_id = auth.uid()
);

CREATE POLICY "Talents can delete own interview results"
ON public.interview_results
FOR DELETE
TO authenticated
USING (
  user_id = auth.uid()
);

CREATE POLICY "Public can view all interview_results"
ON public.interview_results
FOR SELECT
TO public
USING (
    true
);



--onboarding_requests--
CREATE POLICY "onboarding_requests_anon_insert"
ON public.onboarding_requests
AS PERMISSIVE
FOR INSERT
TO anon
WITH CHECK (true);

-- Allow anonymous users to view onboarding_requests

CREATE POLICY "Anyone can view onboarding_requests"
ON public.onboarding_requests
FOR SELECT
TO public
USING (true);

CREATE POLICY "admin_can_update_onboarding_requests"
ON public.onboarding_requests
FOR UPDATE
TO authenticated
USING (auth.uid() IN (SELECT user_id FROM public.admins))
WITH CHECK (auth.uid() IN (SELECT user_id FROM public.admins));

CREATE POLICY "admin_can_delete_onboarding_requests"
ON public.onboarding_requests
FOR DELETE
TO authenticated
USING (auth.uid() IN (SELECT user_id FROM public.admins));




--RLS--RLS--RLS--RLS--RLS--RLS--RLS--RLS--RLS--RLS--RLS--RLS--RLS--RLS--RLS--RLS--
ALTER TABLE "public"."admins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."company_boards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."company_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."companies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."interview_results" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_interviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."candidate_job_pipeline" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."candidate_job_offers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."interviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."profile_availabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."unauth_job_views" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."app_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."onboarding_requests" ENABLE ROW LEVEL SECURITY;


GRANT ALL ON FUNCTION "public"."check_phone_in_company_members"("p_phone" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."check_email_in_company_members"("p_email" "text") TO "anon";

GRANT ALL ON FUNCTION "public"."get_user_id_by_email"("p_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_id_by_email"("p_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_id_by_email"("p_email" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_user_id_by_phone"("p_phone" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_id_by_phone"("p_phone" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_id_by_phone"("p_phone" "text") TO "service_role";



--seed data--
-- Add finalpassscore and interview_attempt_limits and salary_popup_date to app_settings
INSERT INTO "public"."app_settings" ("key", "value", "description")
VALUES 
  ('salary_popup_date', '2025-07-22', 'Date until which salary popup should be shown for new users'),
  ('finalpassscore', '65', 'Minimum score required to pass assessments'),
  ('interview_attempt_limits', '2', 'Maximum number of interview attempts allowed')
ON CONFLICT ("key") DO UPDATE SET
  "value" = EXCLUDED."value",
  "description" = EXCLUDED."description",
  "updated_at" = now(); 



--STORAGE BUCKETS--STORAGE BUCKETS--STORAGE BUCKETS--STORAGE BUCKETS--STORAGE BUCKETS--STORAGE BUCKETS--
--Create storage buckets--
--------------------------
--storage buckets policy--

--AUDIO BUCKET--
create policy "Allow public uploads"
on "storage"."objects"
as permissive
for insert
to public
with check (((bucket_id = 'audio'::text) AND (owner = auth.uid())));

--RESUMES BUCKET--
create policy "Users can delete their own resumes"
on "storage"."objects"
as permissive
for delete
to authenticated
using (((bucket_id = 'resumes'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));


create policy "Users can read their own resumes"
on "storage"."objects"
as permissive
for select
to authenticated
using (((bucket_id = 'resumes'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));


create policy "Users can update their own resumes"
on "storage"."objects"
as permissive
for update
to authenticated
using (((bucket_id = 'resumes'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));


create policy "Users can upload their own resumes"
on "storage"."objects"
as permissive
for insert
to authenticated
with check (((bucket_id = 'resumes'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));


--COMPANYPROFILEIMAGE BUCKET--

-- INSERT: Allow only authenticated users to upload and be the owner
CREATE POLICY "Allow authenticated upload with owner check for companyprofileimage"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'companyprofileimage'
  AND owner = auth.uid()
);

-- SELECT: Allow users to read their own files
CREATE POLICY "Read own companyprofileimage"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'companyprofileimage'
  AND owner = auth.uid()
);

-- DELETE: Allow users to delete their own files
CREATE POLICY "Delete own companyprofileimage"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'companyprofileimage'
  AND owner = auth.uid()
);

--TALENTPROFILEPICTURES BUCKET--
-- INSERT: only allow authenticated users to upload to the bucket and be the owner
CREATE POLICY "Allow authenticated upload with owner check"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'talentprofilepictures'
  AND owner = auth.uid()
);

-- SELECT (optional): allow users to read their own files
CREATE POLICY "Read own talentprofilepictures"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'talentprofilepictures'
  AND owner = auth.uid()
);

-- DELETE (optional): allow users to delete their own files
CREATE POLICY "Delete own talentprofilepictures"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'talentprofilepictures'
  AND owner = auth.uid()
);







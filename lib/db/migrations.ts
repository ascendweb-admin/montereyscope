import type { Migration } from "./migrator";

/**
 * Initial scope schema.
 *
 * Timestamps are ISO 8601 TEXT values so they stay readable in any SQLite
 * browser. `live_status` and `source` are constrained at the database level
 * because yt-dlp output is untrusted input.
 */
export const INITIAL_MIGRATIONS: readonly Migration[] = [
  {
    id: "001",
    name: "initial_schema_creators_videos_transcripts_settings",
    sql: `
      CREATE TABLE creators (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        youtube_channel_id TEXT,
        handle TEXT,
        display_name TEXT NOT NULL,
        channel_url TEXT NOT NULL,
        avatar_url TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        last_refreshed_at TEXT
      );

      -- Unique only when the canonical channel ID is known.
      CREATE UNIQUE INDEX idx_creators_youtube_channel_id
        ON creators (youtube_channel_id)
        WHERE youtube_channel_id IS NOT NULL;

      CREATE INDEX idx_creators_display_name ON creators (display_name);

      CREATE TABLE videos (
        id TEXT PRIMARY KEY,
        creator_id INTEGER NOT NULL REFERENCES creators (id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        thumbnail_url TEXT,
        published_at TEXT,
        duration_seconds INTEGER,
        live_status TEXT NOT NULL DEFAULT 'unknown'
          CHECK (live_status IN ('not_live', 'is_live', 'was_live', 'upcoming', 'unknown')),
        description TEXT,
        fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      -- Creator lookup and publish ordering for the channel feed tabs.
      CREATE INDEX idx_videos_creator_published
        ON videos (creator_id, published_at DESC);

      CREATE INDEX idx_videos_creator_live_status
        ON videos (creator_id, live_status);

      CREATE TABLE transcripts (
        video_id TEXT PRIMARY KEY REFERENCES videos (id) ON DELETE CASCADE,
        language TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('manual', 'automatic')),
        plain_text TEXT NOT NULL,
        fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

/**
 * AI chat persistence. `selected_video_ids` is a JSON array of video ids in
 * request order; `codex_work_dir` is the materialized transcript job directory
 * that doubles as the Codex working directory, kept so later turns can resume
 * the same Codex session against the same files. `role` is constrained because
 * message roles drive the chat UI.
 */
export const AI_CHAT_MIGRATIONS: readonly Migration[] = [
  {
    id: "002",
    name: "ai_chat_threads_and_messages",
    sql: `
      CREATE TABLE ai_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        codex_session_id TEXT,
        codex_work_dir TEXT NOT NULL,
        selected_video_ids TEXT NOT NULL CHECK (json_valid(selected_video_ids)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE ai_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES ai_threads (id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      -- Thread history is always read oldest-first for one thread.
      CREATE INDEX idx_ai_messages_thread_id ON ai_messages (thread_id, id);
    `,
  },
];

/**
 * AI HTML report jobs. One row per requested report: `selected_video_ids` is
 * the scope as a JSON array in request order, `status` moves queued → running
 * → done|failed (constrained because the reports list UI branches on it),
 * `file_path` registers the HTML file Codex produced inside the job
 * directory, and `error` holds a client-safe failure message.
 */
export const AI_REPORTS_MIGRATIONS: readonly Migration[] = [
  {
    id: "003",
    name: "ai_reports",
    sql: `
      CREATE TABLE ai_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        selected_video_ids TEXT NOT NULL CHECK (json_valid(selected_video_ids)),
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'done', 'failed')),
        file_path TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        completed_at TEXT
      );

      -- The reports list reads newest-first; the queue picks oldest queued first.
      CREATE INDEX idx_ai_reports_created ON ai_reports (created_at DESC, id DESC);
    `,
  },
];

/**
 * Chat intelligence modes. One `mode` per thread records which research
 * setting the conversation runs in (model + reasoning effort + persona
 * directive); 'deep' backfills every pre-mode thread, which all ran the deep
 * configuration. The value may change mid-thread when the user switches
 * modes in the panel, so it is plain data rather than part of the schema's
 * identity.
 */
export const AI_CHAT_MODES_MIGRATIONS: readonly Migration[] = [
  {
    id: "004",
    name: "ai_threads_chat_mode",
    sql: `
      ALTER TABLE ai_threads ADD COLUMN mode TEXT NOT NULL DEFAULT 'deep'
        CHECK (mode IN ('quick', 'balanced', 'deep'));
    `,
  },
];

/**
 * Report depth profiles and visual styles. One `profile` (brief / balanced /
 * deep — model, reasoning effort, and writing brief) and one `style` (the
 * shipped stylesheet the report is written in) per report, recorded so the
 * list page can show what each report is and the runner can pin the run.
 * 'balanced' and 'editorial' backfill pre-options reports, which ran the
 * balanced writing brief in what is now the editorial style.
 */
export const AI_REPORT_OPTIONS_MIGRATIONS: readonly Migration[] = [
  {
    id: "005",
    name: "ai_reports_profile_and_style",
    sql: `
      ALTER TABLE ai_reports ADD COLUMN profile TEXT NOT NULL DEFAULT 'balanced'
        CHECK (profile IN ('brief', 'balanced', 'deep'));

      ALTER TABLE ai_reports ADD COLUMN style TEXT NOT NULL DEFAULT 'editorial'
        CHECK (style IN ('editorial', 'terminal', 'swiss'));
    `,
  },
];

/**
 * User-defined creator categories. Categories are intentionally independent
 * from creators: removing a category only removes its memberships, while
 * removing a creator cleans up its memberships alongside the existing feed
 * cascade. `color` is a small, app-owned palette key rather than arbitrary
 * CSS so every saved category remains readable in light and dark themes.
 */
export const CREATOR_CATEGORY_MIGRATIONS: readonly Migration[] = [
  {
    id: "006",
    name: "creator_categories",
    sql: `
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE,
        color TEXT NOT NULL DEFAULT 'slate'
          CHECK (color IN ('slate', 'rose', 'amber', 'emerald', 'sky', 'violet')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE UNIQUE INDEX idx_categories_name_nocase
        ON categories (name COLLATE NOCASE);

      CREATE TABLE creator_categories (
        creator_id INTEGER NOT NULL REFERENCES creators (id) ON DELETE CASCADE,
        category_id INTEGER NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (creator_id, category_id)
      );

      CREATE INDEX idx_creator_categories_category
        ON creator_categories (category_id, creator_id);
    `,
  },
];

/**
 * Which AI CLI a thread's turns run on (stage 9). scope can drive the codex
 * CLI and the opencode CLI, and a Codex session id can only be resumed by
 * codex while an opencode session id only exists inside opencode — recording
 * the backend per thread lets a resume turn detect a mid-conversation switch
 * and start a fresh session (re-seeded with the instruction) instead of
 * feeding one CLI's session id to the other. Threads never switch back
 * automatically: the column follows the backend the latest turn ran on.
 */
export const AI_BACKEND_MIGRATIONS: readonly Migration[] = [
  {
    id: "007",
    name: "ai_threads_backend",
    sql: `
      ALTER TABLE ai_threads ADD COLUMN backend TEXT NOT NULL DEFAULT 'codex'
        CHECK (backend IN ('codex', 'opencode'));
    `,
  },
];

/**
 * Report identity and cleanup metadata. `title` and `dek` hold the headline
 * and standfirst the analyst wrote into the finished HTML document —
 * extracted when the run completes so the reports list can show what each
 * report actually is instead of "Report #N" (a user rename overwrites them).
 * `job_dir` records the materialized transcript directory so deleting a
 * report removes its files from disk in one step.
 */
export const AI_REPORT_META_MIGRATIONS: readonly Migration[] = [
  {
    id: "008",
    name: "ai_reports_title_dek_job_dir",
    sql: `
      ALTER TABLE ai_reports ADD COLUMN title TEXT;

      ALTER TABLE ai_reports ADD COLUMN dek TEXT;

      ALTER TABLE ai_reports ADD COLUMN job_dir TEXT;
    `,
  },
];

/**
 * Creator platform. scope's first-class flow remains YouTube channels, but
 * Rumble creators can be added from a channel or video link and refreshed
 * from Rumble's own listing pages. Existing rows backfill as 'youtube', and
 * the CHECK keeps the platform enum closed because the UI branches on it
 * (disclaimer copy, refresh behavior, external-link labels).
 */
export const CREATOR_PLATFORM_MIGRATIONS: readonly Migration[] = [
  {
    id: "009",
    name: "creators_platform",
    sql: `
      ALTER TABLE creators ADD COLUMN platform TEXT NOT NULL DEFAULT 'youtube'
        CHECK (platform IN ('youtube', 'rumble'));
    `,
  },
];

/**
 * Claude Code as a third AI backend. Migration 007 pinned
 * `ai_threads.backend` to codex/opencode; SQLite cannot alter a CHECK
 * constraint in place, so this adds a replacement column with the widened
 * enum, copies every stored value (ids, sessions, modes, and timestamps are
 * untouched), drops the old column, and renames the replacement. The
 * migrator runs each migration in one transaction, so a failure leaves the
 * table exactly as it was. `ai_messages` is never dropped, so its cascading
 * foreign key can't take thread history with it.
 */
export const AI_CLAUDE_BACKEND_MIGRATIONS: readonly Migration[] = [
  {
    id: "010",
    name: "ai_threads_backend_claude",
    sql: `
      ALTER TABLE ai_threads ADD COLUMN backend_new TEXT NOT NULL DEFAULT 'codex'
        CHECK (backend_new IN ('codex', 'opencode', 'claude'));

      UPDATE ai_threads SET backend_new = backend;

      ALTER TABLE ai_threads DROP COLUMN backend;

      ALTER TABLE ai_threads RENAME COLUMN backend_new TO backend;
    `,
  },
];

/**
 * X (Twitter) as a third creator platform. Migration 009 pinned
 * `creators.platform` to youtube/rumble; SQLite cannot alter a CHECK
 * constraint in place, so this adds a replacement column with the widened
 * enum and copies every stored value, ids and timestamps untouched.
 * `platform_user_id` holds the platform-stable account identity (the X user
 * id, which exceeds JavaScript's safe integer range and stays TEXT); the
 * partial unique index keeps one saved creator per identity without
 * disturbing YouTube rows, which dedupe on `youtube_channel_id`.
 */
export const CREATOR_PLATFORM_X_MIGRATIONS: readonly Migration[] = [
  {
    id: "011",
    name: "creators_platform_x_and_user_id",
    sql: `
      ALTER TABLE creators ADD COLUMN platform_new TEXT NOT NULL DEFAULT 'youtube'
        CHECK (platform_new IN ('youtube', 'rumble', 'x'));

      UPDATE creators SET platform_new = platform;

      ALTER TABLE creators DROP COLUMN platform;

      ALTER TABLE creators RENAME COLUMN platform_new TO platform;

      ALTER TABLE creators ADD COLUMN platform_user_id TEXT;

      CREATE UNIQUE INDEX idx_creators_platform_user_id
        ON creators (platform, platform_user_id)
        WHERE platform_user_id IS NOT NULL;
    `,
  },
];

/**
 * Cached X posts. Tweets are first-class content: the post itself lives once
 * in `tweets` (keyed by the canonical status id, TEXT because X ids exceed
 * the safe integer range), and each saved creator timeline links to it
 * through `creator_tweets`, so a repost or the same post surfacing in several
 * timelines never duplicates the underlying text. Timeline event kind and
 * time are stored on the membership, distinct from the post's publication
 * time. Content status marks genuinely truncated or unavailable payloads;
 * metrics stay nullable rather than fabricated zeroes.
 *
 * `x_feed_state` records one creator's bounded timeline cursor and the
 * account/provider/filter configuration it belongs to, so a configuration
 * change invalidates the cursor instead of mixing windows.
 */
export const TWEET_CACHE_MIGRATIONS: readonly Migration[] = [
  {
    id: "012",
    name: "tweets_creator_timelines_and_x_feed_state",
    sql: `
      CREATE TABLE tweets (
        id TEXT PRIMARY KEY,
        author_user_id TEXT NOT NULL,
        author_handle TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        url TEXT NOT NULL,
        text TEXT NOT NULL,
        language TEXT,
        published_at TEXT,
        fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        reply_count INTEGER,
        repost_count INTEGER,
        like_count INTEGER,
        quote_count INTEGER,
        content_status TEXT NOT NULL DEFAULT 'complete'
          CHECK (content_status IN ('summary', 'complete', 'unavailable')),
        is_repost INTEGER NOT NULL DEFAULT 0 CHECK (is_repost IN (0, 1)),
        reposted_by_user_id TEXT,
        reposted_by_handle TEXT,
        conversation_id TEXT,
        in_reply_to_tweet_id TEXT,
        in_reply_to_user_id TEXT,
        in_reply_to_handle TEXT,
        quoted_tweet_id TEXT,
        quoted_user_id TEXT,
        quoted_handle TEXT,
        quoted_name TEXT,
        quoted_text TEXT,
        quoted_url TEXT,
        media_json TEXT CHECK (media_json IS NULL OR json_valid(media_json))
      );

      CREATE INDEX idx_tweets_author_published ON tweets (author_user_id, published_at DESC);
      CREATE INDEX idx_tweets_conversation ON tweets (conversation_id);

      CREATE TABLE creator_tweets (
        creator_id INTEGER NOT NULL REFERENCES creators (id) ON DELETE CASCADE,
        tweet_id TEXT NOT NULL REFERENCES tweets (id) ON DELETE CASCADE,
        timeline_kind TEXT NOT NULL DEFAULT 'post'
          CHECK (timeline_kind IN ('post', 'repost', 'reply')),
        timeline_at TEXT,
        source TEXT NOT NULL DEFAULT 'timeline'
          CHECK (source IN ('timeline', 'import')),
        saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (creator_id, tweet_id)
      );

      CREATE INDEX idx_creator_tweets_timeline
        ON creator_tweets (creator_id, timeline_at DESC);
      CREATE INDEX idx_creator_tweets_tweet ON creator_tweets (tweet_id);

      CREATE TABLE x_feed_state (
        creator_id INTEGER PRIMARY KEY REFERENCES creators (id) ON DELETE CASCADE,
        config_key TEXT NOT NULL,
        last_refreshed_at TEXT,
        older_cursor TEXT,
        exhausted INTEGER NOT NULL DEFAULT 0 CHECK (exhausted IN (0, 1)),
        last_error TEXT
      );
    `,
  },
];

/**
 * Mixed-source analysis selections. Chat threads and report jobs historically
 * stored a JSON array of video ids in `selected_video_ids`; the new
 * `selected_sources` column stores a versioned document
 * `{ version: 1, sources: [{ kind: 'video' | 'tweet', id }] }`. Existing rows
 * are backfilled as video references so old threads and reports keep opening;
 * the legacy column stays in place for old readers and is still written by
 * new jobs.
 */
export const AI_SELECTED_SOURCES_MIGRATIONS: readonly Migration[] = [
  {
    id: "013",
    name: "ai_threads_and_reports_selected_sources",
    sql: `
      ALTER TABLE ai_threads ADD COLUMN selected_sources TEXT
        CHECK (selected_sources IS NULL OR json_valid(selected_sources));

      ALTER TABLE ai_reports ADD COLUMN selected_sources TEXT
        CHECK (selected_sources IS NULL OR json_valid(selected_sources));

      UPDATE ai_threads
      SET selected_sources = json_object(
        'version', 1,
        'sources', CASE
          WHEN json_type(selected_video_ids) = 'array' THEN (
            SELECT COALESCE(
              json_group_array(json_object('kind', 'video', 'id', value)),
              json('[]')
            )
            FROM json_each(ai_threads.selected_video_ids)
          )
          ELSE json('[]')
        END
      );

      UPDATE ai_reports
      SET selected_sources = json_object(
        'version', 1,
        'sources', CASE
          WHEN json_type(selected_video_ids) = 'array' THEN (
            SELECT COALESCE(
              json_group_array(json_object('kind', 'video', 'id', value)),
              json('[]')
            )
            FROM json_each(ai_reports.selected_video_ids)
          )
          ELSE json('[]')
        END
      );
    `,
  },
];

/**
 * Discovered model catalog cache. One row per provider holds the last
 * authoritative snapshot; `connection_key` is an opaque credential-generation
 * identity (never an account identifier) so a snapshot from a previous login
 * can be discarded when the account changes. `models` is a JSON array of
 * normalized entries that already carry first-seen timestamps, and
 * `baseline_at` marks the first successful discovery so the whole first
 * catalog is never badged as new. No token or account data is ever stored
 * here.
 */
export const AI_MODEL_CATALOG_MIGRATIONS: readonly Migration[] = [
  {
    id: "014",
    name: "ai_model_catalog_cache",
    sql: `
      CREATE TABLE ai_model_catalog (
        provider TEXT PRIMARY KEY CHECK (provider IN ('codex', 'opencode', 'claude')),
        connection_key TEXT NOT NULL,
        runtime_version TEXT,
        state TEXT NOT NULL CHECK (state IN ('live', 'empty', 'failed')),
        revision INTEGER NOT NULL DEFAULT 0,
        models TEXT NOT NULL CHECK (json_valid(models)),
        source TEXT,
        last_attempt_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        baseline_at TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

/** Local research lists reference the shared creator library and archive. */
export const X_RESEARCH_LIST_MIGRATIONS: readonly Migration[] = [
  {
    id: "015",
    name: "x_research_lists",
    sql: `
      CREATE TABLE x_research_lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE x_research_list_members (
        list_id INTEGER NOT NULL REFERENCES x_research_lists(id) ON DELETE CASCADE,
        creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (list_id, creator_id)
      );
      CREATE INDEX idx_x_research_member_creator ON x_research_list_members(creator_id);
      CREATE TRIGGER x_research_member_platform BEFORE INSERT ON x_research_list_members
      WHEN NOT EXISTS (SELECT 1 FROM creators WHERE id = NEW.creator_id AND platform = 'x')
      BEGIN SELECT RAISE(ABORT, 'Research lists require X creators'); END;
    `,
  },
];

/** Durable manual X retrieval; checkpoints are independent of display filters. */
export const X_RETRIEVAL_MIGRATIONS: readonly Migration[] = [
  {
    id: "016",
    name: "x_durable_retrieval",
    sql: `
      CREATE TABLE x_retrieval_checkpoints (
        creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
        config_key TEXT NOT NULL,
        lane TEXT NOT NULL CHECK (lane IN ('head', 'history')),
        state_json TEXT NOT NULL CHECK (json_valid(state_json)),
        PRIMARY KEY (creator_id, config_key, lane)
      );
      CREATE TABLE x_retrieval_jobs (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        cancelled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE x_retrieval_tasks (
        id TEXT PRIMARY KEY,
        creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
        config_key TEXT NOT NULL,
        work_key TEXT NOT NULL,
        state_json TEXT NOT NULL CHECK (json_valid(state_json))
      );
      CREATE INDEX idx_x_retrieval_work ON x_retrieval_tasks(work_key);
      CREATE TABLE x_retrieval_job_tasks (
        job_id TEXT NOT NULL REFERENCES x_retrieval_jobs(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES x_retrieval_tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (job_id, task_id)
      );
    `,
  },
];

/** Keep archived text provenance separate from the latest availability observation. */
export const X_ARCHIVE_OBSERVATION_MIGRATIONS: readonly Migration[] = [
  {
    id: "017",
    name: "x_archive_observations",
    sql: `
      ALTER TABLE tweets ADD COLUMN text_fetched_at TEXT;
      ALTER TABLE tweets ADD COLUMN availability_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (availability_status IN ('unknown', 'observed', 'not_retrievable'));
      ALTER TABLE tweets ADD COLUMN availability_checked_at TEXT;
    `,
  },
];

/** Canonical text and quoted speech stay independently searchable/attributable. */
export const X_TEXT_SEARCH_MIGRATIONS: readonly Migration[] = [
  {
    id: "018",
    name: "x_transactional_text_search",
    sql: `
      CREATE VIRTUAL TABLE x_tweet_text USING fts5(
        text, quoted_text, content='tweets', content_rowid='rowid',
        tokenize="unicode61 remove_diacritics 0 tokenchars '$'"
      );
      CREATE TRIGGER x_tweet_text_insert AFTER INSERT ON tweets BEGIN
        INSERT INTO x_tweet_text(rowid, text, quoted_text)
          VALUES (new.rowid, new.text, new.quoted_text);
      END;
      CREATE TRIGGER x_tweet_text_delete AFTER DELETE ON tweets BEGIN
        INSERT INTO x_tweet_text(x_tweet_text, rowid, text, quoted_text)
          VALUES ('delete', old.rowid, old.text, old.quoted_text);
      END;
      CREATE TRIGGER x_tweet_text_update AFTER UPDATE OF text, quoted_text ON tweets
        WHEN old.text IS NOT new.text OR old.quoted_text IS NOT new.quoted_text BEGIN
        INSERT INTO x_tweet_text(x_tweet_text, rowid, text, quoted_text)
          VALUES ('delete', old.rowid, old.text, old.quoted_text);
        INSERT INTO x_tweet_text(rowid, text, quoted_text)
          VALUES (new.rowid, new.text, new.quoted_text);
      END;
      INSERT INTO x_tweet_text(x_tweet_text) VALUES ('rebuild');
    `,
  },
];

/** Durable corpus analysis. Snapshots deliberately have no archive/creator FK:
 * deleting a library record must not rewrite answer-time evidence. */
export const X_ANALYSIS_MIGRATIONS: readonly Migration[] = [
  {
    id: "019",
    name: "x_research_corpus_analysis",
    sql: `
      CREATE TABLE x_research_scopes (
        id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL CHECK(json_valid(request_json)),
        summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
        created_at TEXT NOT NULL
      );
      CREATE TABLE x_research_scope_posts (
        scope_id TEXT NOT NULL REFERENCES x_research_scopes(id),
        tweet_id TEXT NOT NULL,
        creator_id INTEGER NOT NULL,
        event_at TEXT,
        version TEXT NOT NULL,
        exclusion TEXT,
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
        PRIMARY KEY(scope_id, tweet_id)
      );
      CREATE INDEX idx_x_scope_posts_order ON x_research_scope_posts(scope_id, creator_id, event_at, tweet_id);
      CREATE TRIGGER x_scope_immutable BEFORE UPDATE ON x_research_scopes BEGIN
        SELECT RAISE(ABORT, 'Research scope revisions are immutable');
      END;
      CREATE TRIGGER x_scope_post_immutable BEFORE UPDATE ON x_research_scope_posts BEGIN
        SELECT RAISE(ABORT, 'Research source snapshots are immutable');
      END;
      CREATE TABLE x_analysis_jobs (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL REFERENCES x_research_scopes(id),
        config_json TEXT NOT NULL CHECK(json_valid(config_json)),
        state_json TEXT NOT NULL CHECK(json_valid(state_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE x_analysis_batches (
        job_id TEXT NOT NULL REFERENCES x_analysis_jobs(id) ON DELETE CASCADE,
        batch_key TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('scan', 'reduce', 'synthesize', 'verify')),
        ordinal INTEGER NOT NULL,
        cache_key TEXT NOT NULL,
        input_json TEXT NOT NULL CHECK(json_valid(input_json)),
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'complete', 'superseded', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        error TEXT,
        PRIMARY KEY(job_id, batch_key)
      );
      CREATE INDEX idx_x_batches_pending ON x_analysis_batches(job_id, phase, status, ordinal);
      CREATE INDEX idx_x_batches_cache ON x_analysis_batches(cache_key, status);
      CREATE TABLE x_analysis_segments (
        job_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        batch_key TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        PRIMARY KEY(job_id, unit_id),
        FOREIGN KEY(job_id, batch_key) REFERENCES x_analysis_batches(job_id, batch_key) ON DELETE CASCADE
      );
      CREATE INDEX idx_x_segments_post ON x_analysis_segments(job_id, post_id, active);
      CREATE TABLE x_analysis_post_results (
        job_id TEXT NOT NULL REFERENCES x_analysis_jobs(id) ON DELETE CASCADE,
        tweet_id TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('relevant', 'not_relevant', 'uncertain')),
        result_json TEXT NOT NULL CHECK(json_valid(result_json)),
        PRIMARY KEY(job_id, tweet_id)
      );
      ALTER TABLE ai_threads ADD COLUMN research_scope_id TEXT REFERENCES x_research_scopes(id);
      ALTER TABLE ai_threads ADD COLUMN research_job_id TEXT REFERENCES x_analysis_jobs(id);
      ALTER TABLE ai_reports ADD COLUMN research_scope_id TEXT REFERENCES x_research_scopes(id);
      ALTER TABLE ai_reports ADD COLUMN research_job_id TEXT REFERENCES x_analysis_jobs(id);
    `,
  },
  {
    id: "020",
    name: "x_research_snapshot_memberships",
    sql: `
      CREATE TABLE x_research_scope_memberships (
        scope_id TEXT NOT NULL,
        tweet_id TEXT NOT NULL,
        creator_id INTEGER NOT NULL,
        PRIMARY KEY(scope_id, tweet_id, creator_id),
        FOREIGN KEY(scope_id, tweet_id) REFERENCES x_research_scope_posts(scope_id, tweet_id)
      );
      CREATE INDEX idx_x_scope_memberships_creator ON x_research_scope_memberships(scope_id, creator_id, tweet_id);
      INSERT INTO x_research_scope_memberships
        SELECT p.scope_id, p.tweet_id, json_extract(m.value, '$.creatorId')
          FROM x_research_scope_posts p JOIN json_each(p.snapshot_json, '$.provenance') m;
      CREATE TRIGGER x_scope_membership_immutable BEFORE UPDATE ON x_research_scope_memberships BEGIN
        SELECT RAISE(ABORT, 'Research memberships are immutable');
      END;
    `,
  },
];

/** Every migration the app ships, applied in id order on first connection. */
export const ALL_MIGRATIONS: readonly Migration[] = [
  ...INITIAL_MIGRATIONS,
  ...AI_CHAT_MIGRATIONS,
  ...AI_REPORTS_MIGRATIONS,
  ...AI_CHAT_MODES_MIGRATIONS,
  ...AI_REPORT_OPTIONS_MIGRATIONS,
  ...CREATOR_CATEGORY_MIGRATIONS,
  ...AI_BACKEND_MIGRATIONS,
  ...AI_REPORT_META_MIGRATIONS,
  ...CREATOR_PLATFORM_MIGRATIONS,
  ...AI_CLAUDE_BACKEND_MIGRATIONS,
  ...CREATOR_PLATFORM_X_MIGRATIONS,
  ...TWEET_CACHE_MIGRATIONS,
  ...AI_SELECTED_SOURCES_MIGRATIONS,
  ...AI_MODEL_CATALOG_MIGRATIONS,
  ...X_RESEARCH_LIST_MIGRATIONS,
  ...X_RETRIEVAL_MIGRATIONS,
  ...X_ARCHIVE_OBSERVATION_MIGRATIONS,
  ...X_TEXT_SEARCH_MIGRATIONS,
  ...X_ANALYSIS_MIGRATIONS,
  {
    id: "021",
    name: "x_research_conversation_turns",
    sql: `
      CREATE TABLE x_research_turns (
        job_id TEXT PRIMARY KEY REFERENCES x_analysis_jobs(id),
        thread_id INTEGER NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
        user_message_id INTEGER NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
        assistant_message_id INTEGER REFERENCES ai_messages(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_x_research_turn_thread ON x_research_turns(thread_id);
      ALTER TABLE ai_reports ADD COLUMN research_html TEXT;
    `,
  },  {
    id: "022",
    name: "x_dashboard_seen_and_insights",
    sql: `
      -- When each dashboard scope ('all' or 'list:<id>') was last viewed; drives unread counts.
      CREATE TABLE x_dashboard_seen (
        scope_key TEXT PRIMARY KEY,
        seen_at TEXT NOT NULL
      );
      -- One AI analysis of a feed scope, with its follow-up conversation.
      CREATE TABLE x_insights (
        id TEXT PRIMARY KEY,
        list_id INTEGER REFERENCES x_research_lists(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        preset TEXT,
        scope_json TEXT NOT NULL,
        post_count INTEGER NOT NULL,
        backend TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT,
        session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'cancelled')),
        error TEXT,
        report_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX idx_x_insights_created ON x_insights(created_at DESC);
      CREATE TABLE x_insight_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        insight_id TEXT NOT NULL REFERENCES x_insights(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'complete'
          CHECK (status IN ('running', 'complete', 'failed', 'cancelled')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX idx_x_insight_messages ON x_insight_messages(insight_id, id);
      -- The posts an insight read, frozen at creation so citations and follow-ups stay stable.
      CREATE TABLE x_insight_posts (
        insight_id TEXT NOT NULL REFERENCES x_insights(id) ON DELETE CASCADE,
        tweet_id TEXT NOT NULL,
        PRIMARY KEY (insight_id, tweet_id)
      );
    `,
  },
];

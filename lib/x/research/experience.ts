import { acquireChatTurnLock } from "@/lib/ai/chat";
import type { ScopeDatabase } from "@/lib/db/connection";
import { appendMessage, createThread } from "@/lib/ai/threads";
import { createReport, getReport } from "@/lib/ai/reports";
import type { ResearchAnalysisEngine } from "./analysis";
import { getCorpusScope, getCorpusPost, corpusPosts } from "./corpus";
import { readJob } from "./analysis-store";
import { ResearchInputError } from "./input";

export function researchThread(db: ScopeDatabase, id: number) {
  const row = db
    .prepare(
      "SELECT research_scope_id AS scopeId, research_job_id AS jobId FROM ai_threads WHERE id = ?",
    )
    .get(id) as { scopeId: string | null; jobId: string | null } | undefined;
  return row?.scopeId && row.jobId ? { id, scopeId: row.scopeId, jobId: row.jobId } : null;
}
export function conversationForJob(db: ScopeDatabase, jobId: string) {
  const row = db
    .prepare("SELECT thread_id AS id FROM x_research_turns WHERE job_id = ?")
    .get(jobId) as { id: number } | undefined;
  if (!row) return null;
  const turns = db
    .prepare(
      `SELECT j.id, j.config_json, j.state_json FROM x_research_turns t JOIN x_analysis_jobs j ON j.id=t.job_id WHERE t.thread_id=? ORDER BY t.user_message_id`,
    )
    .all(row.id) as Array<{ id: string; config_json: string; state_json: string }>;
  return {
    threadId: row.id,
    turns: turns.map((t) => ({
      id: t.id,
      question: JSON.parse(t.config_json).question,
      state: { status: JSON.parse(t.state_json).status },
    })),
  };
}
/** Persist the question before execution; selected_sources is deliberately empty:
 * the immutable scope is authoritative, never an array of final citations. */
export async function startResearchConversation(
  db: ScopeDatabase,
  engine: ResearchAnalysisEngine,
  input: Record<string, unknown>,
) {
  const release =
    typeof input.threadId === "number" ? await acquireChatTurnLock(input.threadId) : () => {};
  try {
    return await startResearchConversationLocked(db, engine, input);
  } finally {
    release();
  }
}
async function startResearchConversationLocked(
  db: ScopeDatabase,
  engine: ResearchAnalysisEngine,
  input: Record<string, unknown>,
) {
  if (input.execute !== undefined && typeof input.execute !== "boolean")
    throw new ResearchInputError("Choose whether to execute or prepare an estimate.");
  if (
    (input.threadId !== undefined ||
      input.scopeId !== undefined ||
      input.parentJobId !== undefined) &&
    ["listId", "creatorIds", "start", "end", "timezone", "period", "types", "selection"].some(
      (key) => input[key] !== undefined,
    )
  )
    throw new ResearchInputError(
      "Create a new revision to change creators, dates, types or post selection.",
    );
  let thread = null;
  if (input.threadId !== undefined) {
    if (typeof input.threadId !== "number" || !Number.isSafeInteger(input.threadId))
      throw new ResearchInputError("Choose a valid research conversation.");
    thread = researchThread(db, input.threadId);
    if (!thread) throw new ResearchInputError("This research conversation does not exist.", 404);
    const pending = db
      .prepare(
        `SELECT j.state_json FROM x_research_turns t JOIN x_analysis_jobs j ON j.id=t.job_id WHERE t.thread_id=?`,
      )
      .all(thread.id) as Array<{ state_json: string }>;
    if (
      pending.some((r) =>
        ["queued", "running", "waiting_for_provider"].includes(JSON.parse(r.state_json).status),
      )
    )
      throw new ResearchInputError(
        "Stop or finish the active turn before asking a follow-up.",
        409,
      );
    if (input.scopeId !== undefined && input.scopeId !== thread.scopeId)
      throw new ResearchInputError("Create a new revision to change the conversation scope.");
  }
  if (thread && input.parentJobId !== undefined) {
    const turn = db
      .prepare("SELECT job_id FROM x_research_turns WHERE thread_id=? AND job_id=?")
      .get(thread.id, String(input.parentJobId));
    if (!turn) throw new ResearchInputError("The previous turn must belong to this conversation.");
  }
  const job = await engine.start({
    ...input,
    execute: false,
    ...(thread ? { scopeId: thread.scopeId, parentJobId: input.parentJobId ?? thread.jobId } : {}),
  });
  const threadId = db.transaction(() => {
    const id =
      thread?.id ??
      createThread(db, {
        title: job.config.question.slice(0, 80),
        sources: [],
        codexWorkDir: "",
        mode: job.config.mode,
        backend: job.config.backend,
      }).id;
    db.prepare(
      "UPDATE ai_threads SET research_scope_id=?, research_job_id=?, mode=?, backend=? WHERE id=?",
    ).run(job.scopeId, job.id, job.config.mode, job.config.backend, id);
    const message = appendMessage(db, { threadId: id, role: "user", content: job.config.question });
    db.prepare(
      "INSERT INTO x_research_turns(job_id, thread_id, user_message_id) VALUES (?,?,?)",
    ).run(job.id, id, message.id);
    return id;
  })();
  if (input.execute !== false) engine.resume(job.id);
  return { job: engine.job(job.id), threadId };
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
/** Save the verified answer without another inference or legacy materialization.
 * The linked immutable corpus retains every post, including uncited sources. */
export function saveResearchReport(db: ScopeDatabase, jobId: string) {
  const job = readJob(db, jobId);
  if (!job.state.result?.verified || job.state.status !== "complete")
    throw new ResearchInputError(
      "Finish and verify this research turn before saving a brief.",
      409,
    );
  const existing = db
    .prepare("SELECT id FROM ai_reports WHERE research_job_id=? AND status='done'")
    .get(jobId) as { id: number } | undefined;
  if (existing) return getReport(db, existing.id)!;
  const scope = getCorpusScope(db, job.scopeId);
  const answer = job.state.result;
  const claims = answer.claims
    .map(
      (c) =>
        `<tr><td>${escape(
          [
            ...new Set(
              c.evidence.map((e) => {
                const post = getCorpusPost(db, scope.id, e.postId);
                return e.attribution === "quoted"
                  ? `${post.tweet.quoted?.name ?? post.tweet.quoted?.handle ?? "Unspecified quoted speaker"} (quoted by ${post.tweet.authorName})`
                  : post.tweet.authorName;
              }),
            ),
          ].join("; "),
        )}</td><td>${escape(c.claim)}</td><td>${c.evidence.map((e) => `<a href="#post-${escape(e.postId)}">Post ${escape(e.postId)} (${e.attribution})</a><blockquote>${escape(e.excerpt)}</blockquote>`).join("")}</td><td>${escape(c.horizon ?? "Unspecified")}</td><td>${escape(c.condition ?? "Unspecified")}</td><td>${c.interpretation ? "Interpretation" : "Explicit claim"}</td></tr>`,
    )
    .join("");
  const answerText = escape(answer.text).replace(
    /\[tweet:(\d+)\]/g,
    '<a href="#post-$1">Post $1</a>',
  );
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(job.config.question)}</title><style>body{max-width:1100px;margin:auto;padding:32px;font:16px/1.6 system-ui;color:#181818}article,details{border-top:1px solid #ddd;padding:16px 0}pre,p{white-space:pre-wrap;overflow-wrap:anywhere}a{color:inherit}blockquote{border-left:3px solid #ccc;padding-left:16px}table{width:100%;border-collapse:collapse}td,th{text-align:left;vertical-align:top;border:1px solid #ddd;padding:8px}.table{overflow-x:auto}summary{cursor:pointer}</style><h1>${escape(job.config.question)}</h1><p>${answerText}</p><p>${escape(answer.scopeNote)}</p><p>Saved revision ${escape(scope.id)} · ${escape(scope.request.since)} – ${escape(scope.request.until)} (end exclusive) · ${escape(scope.request.timezone)} · ${escape(scope.summary.creators.map((c) => c.name).join(", "))} · ${escape(scope.request.types.join(", "))}</p><div class="table"><table><caption>Grounded comparison</caption><thead><tr><th>Creator / speaker</th><th>Claim</th><th>Rationale / evidence</th><th>Horizon</th><th>Condition</th><th>Reading</th></tr></thead><tbody>${claims}</tbody></table></div><h2>Coverage and exclusions</h2><p>${scope.summary.excluded.incomplete_text} incomplete text · ${scope.summary.excluded.missing_text} missing text · ${scope.summary.excluded.missing_date} missing date</p><p>${escape(scope.summary.limitations.join("\n"))}</p>${scope.summary.coverage.map((c) => `<p>${escape(c.name)}: ${c.cachedPosts} cached posts; observed ${escape(c.oldest ?? "Unknown")} – ${escape(c.newest ?? "Unknown")}; last refresh ${escape(c.lastRefreshedAt ?? "Unknown")}. ${c.hasError || c.pendingHead ? "Partial retrieval." : "Upstream completeness unverified."}</p>`).join("")}<p>Post selection: ${escape(scope.request.selection.kind)}${scope.request.selection.kind === "exact" ? ` · required ${escape(scope.request.selection.search.terms.join("; "))} · aliases ${escape(scope.request.selection.search.aliases.join("; "))} · excluded ${escape(scope.request.selection.search.exclusions.join("; "))}` : ""}. Media and linked pages not analyzed.</p><h2>Answer-time source archive (${scope.summary.total} posts)</h2>`;
  return db.transaction(() => {
    const report = createReport(db, [], { profile: "brief" });
    db.prepare(
      `UPDATE ai_reports SET research_scope_id=?, research_job_id=?, research_html=?, title=?, dek=?, status='done', completed_at=? WHERE id=?`,
    ).run(
      scope.id,
      job.id,
      html,
      job.config.question,
      `${job.progress.reviewed} reviewed cached posts · frozen research brief`,
      new Date().toISOString(),
      report.id,
    );
    return getReport(db, report.id)!;
  })();
}
export function researchReportHtml(db: ScopeDatabase, reportId: number): string | null {
  const row = db
    .prepare(
      "SELECT research_html AS html, research_scope_id AS scopeId FROM ai_reports WHERE id=?",
    )
    .get(reportId) as { html: string | null; scopeId: string | null } | undefined;
  if (!row?.html || !row.scopeId) return null;
  let html = row.html;
  for (const post of corpusPosts(db, row.scopeId, false)) {
    const tweet = post.tweet;
    const url = /^https:\/\/((www\.)?x\.com|twitter\.com)\//.test(tweet.url) ? tweet.url : "#";
    html += `<details id="post-${escape(tweet.id)}"><summary>${escape(tweet.authorName)} · ${escape(tweet.publishedAt ?? "Unknown publication date")} · ${escape(post.postType)}</summary><p>${escape(tweet.text)}</p>${tweet.quoted ? `<blockquote>Quoted context · ${escape(tweet.quoted.name ?? tweet.quoted.handle ?? "Unspecified speaker")}: ${escape(tweet.quoted.text)}</blockquote>` : ""}${post.context ? `<p>Parent context only · ${escape(post.context.author)}: ${escape(post.context.text)}</p>` : ""}<p>Selected timeline attribution: ${escape(post.provenance.map((p) => `${p.name} (${p.kind})`).join(", "))}</p><a href="${escape(url)}">Open on X</a></details>`;
  }
  return html + "</html>";
}

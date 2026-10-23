/**
 * Saves a finished insight to Reports as a self-contained HTML brief: the
 * conversation rendered from Markdown, citations linked to an appendix of
 * the cited posts. No model call; the saved text is exactly what was shown.
 */
import { encodeSourceRefs, type SourceRef } from "@/lib/content/model";
import type { ScopeDatabase } from "@/lib/db/connection";
import {
  createReport,
  getReport,
  getReportSources,
  publicReportFor,
  readReportSourceSnapshot,
  type AiReport,
  type ReportSourceSnapshot,
} from "@/lib/ai/reports";
import { ResearchInputError } from "@/lib/x/research/input";
import type { InsightEngine } from "./insights";
import { markdownPreview, parseInline, parseMarkdown, type Block, type Inline } from "./markdown";
import { PERIOD_LABELS, type InsightDetail } from "./model";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

function inline(nodes: Inline[], detail: InsightDetail): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
          return escape(node.text).replace(/\n/g, "<br>");
        case "strong":
          return `<strong>${inline(node.children, detail)}</strong>`;
        case "em":
          return `<em>${inline(node.children, detail)}</em>`;
        case "code":
          return `<code>${escape(node.text)}</code>`;
        case "link":
          return `<a href="${escape(node.href)}" rel="noreferrer">${inline(node.children, detail)}</a>`;
        case "cite":
          return node.ids
            .map((id) => {
              const source = detail.sources[id];
              return `<a class="cite" href="#post-${escape(id)}">${escape(source ? `@${source.authorHandle}` : "source")}</a>`;
            })
            .join(" ");
      }
    })
    .join("");
}

function blocks(list: Block[], detail: InsightDetail): string {
  return list
    .map((block) => {
      switch (block.kind) {
        case "heading": {
          const level = Math.min(6, block.level + 1);
          return `<h${level}>${inline(parseInline(block.text), detail)}</h${level}>`;
        }
        case "paragraph":
          return `<p>${inline(parseInline(block.text), detail)}</p>`;
        case "quote":
          return `<blockquote>${inline(parseInline(block.text), detail)}</blockquote>`;
        case "code":
          return `<pre><code>${escape(block.text)}</code></pre>`;
        case "rule":
          return "<hr>";
        case "table":
          return `<div class="table"><table><thead><tr>${block.header
            .map(
              (cell, i) =>
                `<th style="text-align:${block.align[i]}">${inline(parseInline(cell), detail)}</th>`,
            )
            .join("")}</tr></thead><tbody>${block.rows
            .map(
              (row) =>
                `<tr>${row.map((cell, i) => `<td style="text-align:${block.align[i]}">${inline(parseInline(cell), detail)}</td>`).join("")}</tr>`,
            )
            .join("")}</tbody></table></div>`;
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          return `<${tag}${block.ordered && block.start !== 1 ? ` start="${block.start}"` : ""}>${block.items
            .map(
              (item) =>
                `<li>${inline(parseInline(item.text), detail)}${item.children ? blocks([item.children], detail) : ""}</li>`,
            )
            .join("")}</${tag}>`;
        }
      }
    })
    .join("\n");
}

export function insightHtml(detail: InsightDetail): string {
  const turns = detail.messages
    .map((message, index) =>
      message.role === "user"
        ? index === 0
          ? ""
          : `<h2 class="question">${escape(message.content)}</h2>`
        : `<section>${blocks(parseMarkdown(message.content), detail)}</section>`,
    )
    .join("\n");
  const sources = Object.values(detail.sources)
    .map(
      (s) =>
        `<li id="post-${escape(s.id)}"><strong>${escape(s.authorName)}</strong> <span class="muted">@${escape(s.authorHandle)}${s.publishedAt ? ` · ${escape(new Date(s.publishedAt).toUTCString())}` : ""}</span><p>${escape(s.text)}</p>${/^https:\/\/(www\.)?(x|twitter)\.com\//.test(s.url) ? `<a href="${escape(s.url)}" rel="noreferrer">Open on X</a>` : ""}</li>`,
    )
    .join("");
  const scope = detail.scope;
  const meta = `${escape(scope.label)} · ${escape(PERIOD_LABELS[scope.period])} · ${detail.postCount} ${detail.postCount === 1 ? "post" : "posts"}${scope.query ? ` · “${escape(scope.query)}”` : ""} · ${escape(detail.model)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(detail.title)}</title><style>
:root{color-scheme:light dark;--fg:#16181c;--muted:#5b6470;--line:#e3e6ea;--bg:#fff;--chip:#eef1f4}
@media (prefers-color-scheme:dark){:root{--fg:#e7e9ea;--muted:#8b98a5;--line:#2f3336;--bg:#0f1114;--chip:#1d2125}}
body{max-width:760px;margin:0 auto;padding:40px 20px 80px;font:16px/1.65 system-ui,-apple-system,sans-serif;color:var(--fg);background:var(--bg)}
h1{font-size:28px;line-height:1.25;margin:0 0 6px}.meta{color:var(--muted);font-size:14px;margin-bottom:28px}
h2,h3,h4{line-height:1.3;margin:28px 0 8px}h2.question{border-top:1px solid var(--line);padding-top:24px;font-size:18px}
a{color:inherit}a.cite{display:inline-block;font-size:12px;text-decoration:none;background:var(--chip);border-radius:999px;padding:0 8px;margin:0 2px;vertical-align:1px}
blockquote{border-left:3px solid var(--line);margin:12px 0;padding:2px 14px;color:var(--muted)}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px;margin:12px 0}th,td{border-bottom:1px solid var(--line);padding:8px 10px;vertical-align:top}th{font-weight:600}
code{background:var(--chip);border-radius:4px;padding:1px 4px;font-size:.9em}pre{background:var(--chip);padding:12px;border-radius:8px;overflow-x:auto}
.sources{border-top:1px solid var(--line);margin-top:40px;padding-top:12px}.sources ol{padding-left:20px}.sources li{margin:14px 0}.sources p{white-space:pre-wrap;margin:4px 0}.muted{color:var(--muted);font-size:14px}
</style></head><body><main><h1>${escape(detail.title)}</h1><p class="meta">${meta}</p>${turns}${sources ? `<div class="sources"><h2>Sources</h2><ol>${sources}</ol></div>` : ""}</main></body></html>`;
}

export function saveInsightReport(db: ScopeDatabase, engine: InsightEngine, id: string): AiReport {
  const detail = engine.detail(id);
  if (detail.status === "running")
    throw new ResearchInputError("Wait for the answer to finish.", 409);
  if (!detail.messages.some((m) => m.role === "assistant" && m.status === "complete"))
    throw new ResearchInputError("There's no finished answer to save yet.", 409);
  const refs: SourceRef[] = (
    db.prepare("SELECT tweet_id AS id FROM x_insight_posts WHERE insight_id = ?").all(id) as Array<{
      id: string;
    }>
  ).map((row) => ({ kind: "tweet", id: row.id }));
  const previous = detail.reportId === null ? null : getReport(db, detail.reportId);
  const sources = new Map(
    (previous ? publicReportFor(db, previous).sources : []).map((source) => [source.id, source]),
  );
  for (const source of getReportSources(db, refs)) sources.set(source.id, source);
  const creatorName = db.prepare(
    `SELECT COALESCE(p.display_name, c.display_name) AS name FROM creators c
     LEFT JOIN creator_profiles p ON p.id = c.profile_id WHERE c.id = ?`,
  );
  for (const source of engine.sourcePosts(id)) {
    const previousSource = sources.get(source.id);
    const creator = creatorName.get(source.creatorId) as { name: string } | undefined;
    sources.set(source.id, {
      kind: "tweet",
      id: source.id,
      title: source.text.replace(/\s+/g, " ").trim().slice(0, 180),
      creatorId: source.creatorId,
      creatorName: previousSource?.creatorName ?? creator?.name ?? source.authorName,
      thumbnailUrl: previousSource?.thumbnailUrl ?? null,
      publishedAt: source.publishedAt,
      url: source.url,
      durationSeconds: null,
    });
  }
  const savedSnapshot = previous
    ? (db
        .prepare("SELECT source_snapshot AS snapshot FROM ai_reports WHERE id = ?")
        .get(previous.id) as { snapshot: string | null })
    : null;
  const citedPosts = {
    ...Object.fromEntries(
      (readReportSourceSnapshot(savedSnapshot?.snapshot ?? null)?.citedPosts ?? []).map((post) => [
        post.id,
        post,
      ]),
    ),
    ...detail.sources,
  };
  const document = insightHtml({ ...detail, sources: citedPosts });
  const snapshot: ReportSourceSnapshot = {
    version: 1,
    origin: "x-dashboard",
    scopeLabel: detail.scope.label,
    sourceCount: detail.postCount,
    citedPosts: Object.values(citedPosts),
    sources: refs.flatMap((ref) => (sources.has(ref.id) ? [sources.get(ref.id)!] : [])),
  };
  if (previous) {
    // Re-saving refreshes the brief with any follow-ups asked since.
    db.prepare(
      "UPDATE ai_reports SET research_html = ?, completed_at = ?, selected_sources = ?, source_snapshot = ? WHERE id = ?",
    ).run(
      document,
      new Date().toISOString(),
      encodeSourceRefs(refs),
      JSON.stringify(snapshot),
      detail.reportId,
    );
    return getReport(db, previous.id)!;
  }
  const answer = detail.messages.find((m) => m.role === "assistant" && m.status === "complete")!;
  return db.transaction(() => {
    const report = createReport(db, refs, { profile: "brief" });
    db.prepare(
      `UPDATE ai_reports SET research_html = ?, title = ?, dek = ?, status = 'done', completed_at = ?, source_snapshot = ? WHERE id = ?`,
    ).run(
      document,
      detail.title,
      markdownPreview(answer.content),
      new Date().toISOString(),
      JSON.stringify(snapshot),
      report.id,
    );
    db.prepare("UPDATE x_insights SET report_id = ? WHERE id = ?").run(report.id, id);
    return getReport(db, report.id)!;
  })();
}

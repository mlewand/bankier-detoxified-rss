# Bankier RSS Declickbait Proxy — Project Summary

## Problem

Bankier.pl's RSS feed (`https://www.bankier.pl/rss/wiadomosci.xml`) uses curiosity-gap headlines that withhold key information to force clicks. The clickbait information is often also missing from the RSS `<description>` field. Goal: build a proxy feed that serves the same content but with rewritten titles/descriptions that actually state the news.

## Stack

- **Runtime**: Cloudflare Workers
- **Language**: TypeScript
- **RSS parsing**: `fast-xml-parser`
- **HTML extraction**: `@mozilla/readability` + `linkedom`
- **LLM**: LLM: provider-abstracted, initially MiniMax (via Token Plan Key), swappable to Anthropic/OpenAI/etc.
- **Storage**: Workers KV (per-article cache, L1) + Cache API (full feed XML, L2)
- **Scheduling**: Cron Triggers, every 2 minutes
- **Hosting cost**: free tier; LLM cost estimated well under $5/month

Rejected alternatives: n8n (wrong tool for single-endpoint proxies), self-hosted VPS (unnecessary overhead), using ChatGPT/Claude subscription credits (not technically possible).

## Architecture — two-stage LLM pipeline

**Stage 1 — Batch classification** (cheap, always runs for new articles):

- Single LLM call per cron run with prompt + few-shot examples + enumerated list of `(id, title, description)` from RSS
- LLM returns structured JSON marking each as clickbait true/false
- Non-clickbait articles → finalized with `status: 'not_clickbait'`, no further work

**Stage 2 — Per-article refinement** (only for clickbait articles):

- Fetch full article HTML from bankier
- Extract text via Readability
- LLM call with article text + original title/description
- LLM returns either refined versions OR signals `keep_original: true` if it judges the original is actually fine
- Parallel execution via `Promise.all` with concurrency cap of 5

## Caching

**L1 — KV, keyed by article ID** (extracted from URL via `/-(\d+)\.html/` regex):

```tsx
{
  id, url, fetchedAt, articleTextHash,
  originalTitle, originalDescription,
  refinedTitle: string | null,
  refinedDescription: string | null,
  status: ArticleStatus,
  retryCount: number
}
```

TTL: effectively permanent (30 days). Article IDs are stable.

**L2 — Cache API, keyed by feed URL**:
Full RSS XML output. TTL: 3 minutes.

## Cron flow (every 2 min)

1. Fetch upstream RSS
2. Batch-read KV for all article IDs
3. Partition into: already-final / needs-classification / needs-refinement (from previous failures)
4. Stage 1 on new articles → update KV
5. Stage 2 on clickbait articles (parallel, `Promise.allSettled`) → update KV
6. Rebuild feed XML, write to L2

## HTTP fetch flow

1. Serve from L2 cache if present
2. On L2 miss: rebuild XML from KV state only (no LLM, no bankier fetches) — read path is never slow
3. Cold start fallback: serve upstream passthrough or empty feed

## Article status state machine

- `pending_classification` — fresh from RSS, not yet classified
- `not_clickbait` — Stage 1 said no, final
- `llm_kept_original` — Stage 2 reviewed, said original is fine, final (`refinedTitle/Description: null`)
- `pending_refinement` — Stage 1 said yes, Stage 2 not done
- `refined` — Stage 2 complete, final
- `error_retryable_classification` / `error_retryable_refinement` — transient failure, retry next cron
- `error_permanent` — 3 retries exhausted, or 404/410, serves originals forever

## Graceful degradation

When refined fields are null (regardless of reason — skipped, kept, failed, pending), serve original title/description. Serving logic: `title = refinedTitle ?? originalTitle`. The output path doesn't care *why* refinement didn't happen.

## Key design principles

- **Decouple read path from compute path**: readers never trigger LLM calls
- **Withheld information is the clickbait signal, not structure**: titles with "X. Y" form are fine if both clauses are informative
- **Two-clause title structure ("X. Y") is not itself a red flag** — only withheld key facts are
- **Retryable vs permanent failures** distinguished in cache; permanent failures stop retrying
- **KISS**: no `llmModel` or `promptVersion` fields until actually needed

## File structure

```
src/
  index.ts          # Worker entry (fetch + scheduled)
  pipeline.ts       # orchestration
  bankier.ts        # upstream fetch + parse + extract
  llm.ts            # classifyBatch + refineArticle
  cache.ts          # KV helpers
  feed.ts           # output RSS generation
  types.ts          # shared types
  config.ts         # env vars
wrangler.toml
package.json
tsconfig.json
```

## Examples for prompt engineering

User provided labeled examples of both clickbait (withheld number, withheld named entity, withheld key noun) and legitimate headlines. These go into Stage 1's few-shot prompt. Key insight: legitimate bankier headlines often use the same "X. Y" structure as clickbait ones, so the LLM must distinguish based on information content, not form.

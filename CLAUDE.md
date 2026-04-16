# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Cloudflare Workers proxy that rewrites clickbait RSS headlines from bankier.pl using a two-stage LLM pipeline. The rewritten feed serves `refinedTitle ?? originalTitle` (graceful degradation when refinement is absent for any reason).

## Commands

```bash
npm run dev       # local dev server at http://localhost:8787
npm test          # run vitest (uses @cloudflare/vitest-pool-workers)
npm run deploy    # deploy to Cloudflare Workers
npm run cf-typegen  # regenerate Env types from wrangler.jsonc bindings
```

Run a single test file:
```bash
npx vitest run test/index.spec.ts
```

## Architecture

The worker has two entry points in `src/index.ts`:
- **`fetch`** — serves cached feed XML from L2 (Cache API); on miss, rebuilds XML from KV only (no LLM, no upstream fetches)
- **`scheduled`** — cron trigger (every 2 min); runs the full pipeline

### Planned file structure (`src/`)

| File | Responsibility |
|---|---|
| `index.ts` | Worker entry: `fetch` + `scheduled` handlers |
| `pipeline.ts` | Cron orchestration: fetch RSS → classify → refine → rebuild feed |
| `bankier.ts` | Fetch upstream RSS, parse XML, extract article text via Readability |
| `llm.ts` | `classifyBatch()` (Stage 1) and `refineArticle()` (Stage 2) |
| `cache.ts` | KV read/write helpers; L2 Cache API helpers |
| `feed.ts` | Build output RSS XML from cached article records |
| `types.ts` | Shared types including `ArticleStatus` and `ArticleRecord` |
| `config.ts` | Env var access |

### Two-stage LLM pipeline

**Stage 1 — batch classification** (one LLM call per cron run):
- Input: list of `(id, title, description)` with few-shot examples
- Output: JSON array marking each article as `clickbait: true/false`
- Non-clickbait → `status: 'not_clickbait'` (final, no further work)

**Stage 2 — per-article refinement** (only for clickbait):
- Fetch full article HTML → extract text via `@mozilla/readability` + `linkedom`
- LLM rewrites title/description OR returns `keep_original: true`
- Run in parallel via `Promise.allSettled` with concurrency cap of 5

### Article status state machine

```
pending_classification
  → not_clickbait            (Stage 1: not clickbait, final)
  → pending_refinement       (Stage 1: is clickbait)
  → error_retryable_classification

pending_refinement
  → refined                  (Stage 2 complete, final)
  → llm_kept_original        (Stage 2: original is fine, final)
  → error_retryable_refinement
  → error_permanent          (3 retries or 404/410)
```

### Caching

- **L1 — KV** keyed by article ID (extracted via `/-(\d+)\.html/`): per-article `ArticleRecord`, TTL ~30 days
- **L2 — Cache API** keyed by feed URL: full RSS XML output, TTL 3 minutes

### LLM

Provider-abstracted; initially MiniMax (Token Plan Key). The `llm.ts` module should be swappable to Anthropic/OpenAI without touching pipeline logic.

### Clickbait signal

Withheld key information is the signal — **not** structural patterns like "X. Y" titles. Legitimate bankier headlines frequently use the same two-clause structure. Few-shot examples in the Stage 1 prompt must convey this distinction.

## Key bindings to add to `wrangler.jsonc`

Before implementing, add:
- KV namespace binding (e.g. `ARTICLE_CACHE`)
- Environment variables / secrets: LLM API key, upstream RSS URL
- Cron trigger: `"triggers": { "crons": ["*/2 * * * *"] }`

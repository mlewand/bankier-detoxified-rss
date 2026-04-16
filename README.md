# bankier-detoxified-rss

A Cloudflare Workers proxy that rewrites clickbait headlines in [bankier.pl](https://www.bankier.pl)'s RSS feed into headlines that actually tell you what the article is about.

Point your RSS reader at the proxy URL instead of bankier.pl's feed. You get the same articles — with headlines that let you decide whether they're worth reading before you click.

---

## The problem

Bankier.pl is a popular Polish financial news site. Their RSS feed frequently publishes headlines like:

> *Prawie miliard na reklamy. Sprawdź, który bank wydał najwięcej*
> ("Almost a billion on ads. Check which bank spent the most")

The article is about PKO BP spending 257 million złoty on marketing (a 48% year-over-year increase). None of that is in the headline or description. The tease is the whole point.

The signal this proxy looks for is **withheld information** — a headline that refers to a specific fact (a number, a named entity, a key noun) without revealing it. Structural patterns like the common Polish two-clause *"X. Y"* headline format are **not** treated as clickbait on their own, since legitimate informative headlines use the same form.

---

## How it works

The proxy runs a two-stage LLM pipeline on a 2-minute cron:

**Stage 1 — Classify** (one LLM call per run)
All new articles are sent to the LLM in a single batch. It returns a JSON array marking each as clickbait or not. Non-clickbait articles are finalized immediately and pass through unchanged.

**Stage 2 — Rewrite** (only for clickbait articles)
For each clickbait article the LLM fetches the full article text via [Readability](https://github.com/mozilla/readability), then rewrites the title and description to lead with the key fact. Up to 5 articles are refined in parallel. If the LLM determines on closer reading that the original is actually fine, it signals `keep_original` and the article passes through unchanged.

When you request the feed, your RSS reader never waits for any of this — the read path serves cached XML directly. All LLM work happens in the background on the cron schedule.

**Graceful degradation**: articles that are still pending, permanently failed, or kept original all fall back to the original bankier.pl title and description. The feed always renders.

### What the output looks like

For a refined article, the description shows:

1. The rewritten description (with the featured image preserved)
2. A horizontal rule separator
3. The original bankier.pl title and description — so you can see what was changed

---

## Deploying your own instance

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is sufficient)
- A [MiniMax API key](https://www.minimaxi.com) (Token Plan Key — estimated cost well under $5/month)
- Node.js and npm

### Setup

**1. Clone and install dependencies**

```bash
git clone https://github.com/mlewand/bankier-detoxified-rss
cd bankier-detoxified-rss
npm install
```

**2. Create a KV namespace**

```bash
npx wrangler kv namespace create ARTICLE_CACHE
```

Copy the `id` from the output and update `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "ARTICLE_CACHE",
    "id": "<your-namespace-id>",
    "preview_id": "<your-preview-namespace-id>"
  }
]
```

**3. Set your LLM API key as a secret**

```bash
npx wrangler secret put LLM_API_KEY
```

**4. Deploy**

```bash
npm run deploy
```

Your proxy is now live. The cron starts processing articles within 2 minutes of the first run.

### Local development

Create a `.dev.vars` file (see `.dev.vars.example`):

```
LLM_API_KEY=your_token_plan_key_here
```

Then start the local dev server:

```bash
npm run dev
```

---

## Architecture

```
src/
  index.ts      Worker entry points: fetch handler + scheduled handler
  pipeline.ts   Cron orchestration: classify → refine → rebuild feed
  bankier.ts    Fetch upstream RSS, parse XML, extract article text
  llm.ts        classifyBatch() and refineArticle() — LLM calls
  cache.ts      KV read/write helpers; Cache API helpers
  feed.ts       Build output RSS XML from cached article records
  types.ts      Shared types (ArticleRecord, ArticleStatus)
  config.ts     Env var access
```

### Article state machine

```
pending_classification
  ├─ not_clickbait            Stage 1: informative headline, final
  ├─ pending_refinement       Stage 1: clickbait detected
  └─ error_retryable_classification

pending_refinement
  ├─ refined                  Stage 2: rewritten, final
  ├─ llm_kept_original        Stage 2: original judged fine, final
  ├─ error_retryable_refinement
  └─ error_permanent          3 retries exhausted, or 404/410
```

### Caching

| Layer | Mechanism | Key | TTL |
|---|---|---|---|
| L1 | Workers KV | Article ID (`/-(\d+)\.html/`) | 30 days |
| L2 | Cache API | Feed URL | 3 minutes |

The L2 cache means most requests return immediately without touching KV or the upstream feed.

### LLM

Currently uses MiniMax M2.7 via the international API endpoint. The `llm.ts` module is provider-abstracted — swapping to Anthropic or OpenAI only requires changing the API call in `callLlm`, not the pipeline logic.

---

## Development

```bash
npm run dev           # local dev server at http://localhost:8787
npm test              # run test suite (vitest + @cloudflare/vitest-pool-workers)
npm run test:coverage # run tests with istanbul coverage report
npm run deploy        # deploy to Cloudflare Workers
npm run cf-typegen    # regenerate Env types from wrangler.jsonc bindings
```

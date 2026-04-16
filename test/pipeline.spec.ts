import { env, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest';
import { runPipeline, runConcurrently } from '../src/pipeline';
import { kvGetArticle } from '../src/cache';

const RSS_ORIGIN = 'https://www.bankier.pl';
const RSS_PATH = '/rss/wiadomosci.xml';
const RSS_URL = RSS_ORIGIN + RSS_PATH;

const LLM_ORIGIN = 'https://api.minimax.io';
const LLM_PATH = '/v1/chat/completions';

const ARTICLE_ID_1 = '9114821';
const ARTICLE_ID_2 = '9113525';
const ARTICLE_PATH_1 = '/wiadomosc/Test-article-9114821.html';
const ARTICLE_PATH_2 = '/wiadomosc/Test-article-9113525.html';
const ARTICLE_URL_1 = RSS_ORIGIN + ARTICLE_PATH_1;
const ARTICLE_URL_2 = RSS_ORIGIN + ARTICLE_PATH_2;

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Bankier.pl</title>
    <link>https://www.bankier.pl</link>
    <description>Wiadomosci</description>
    <item>
      <title>Gdzie najtrudniej o prace? Te wojewodztwa odnotowaly najwiekszy odplyw ogloszen</title>
      <link>${ARTICLE_URL_1}</link>
      <description>&lt;p&gt;Opis artykulu.&lt;/p&gt;</description>
      <pubDate>Wed, 16 Apr 2026 10:00:00 +0200</pubDate>
      <guid>${ARTICLE_URL_1}</guid>
    </item>
    <item>
      <title>Nest Bank stawia na lokaty walutowe. Do 2,25% na depozycie w euro</title>
      <link>${ARTICLE_URL_2}</link>
      <description>Opis drugiego artykulu.</description>
      <pubDate>Wed, 16 Apr 2026 09:00:00 +0200</pubDate>
      <guid>${ARTICLE_URL_2}</guid>
    </item>
  </channel>
</rss>`;

const ARTICLE_HTML = `<!DOCTYPE html><html><body><article><p>Tresc artykulu.</p></article></body></html>`;

function llmBody(content: unknown): string {
	return JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] });
}

function interceptRss(status = 200, body = SAMPLE_RSS) {
	fetchMock.get(RSS_ORIGIN).intercept({ path: RSS_PATH }).reply(status, body);
}

function interceptArticle(path: string, status = 200, body = ARTICLE_HTML) {
	fetchMock.get(RSS_ORIGIN).intercept({ path, method: 'GET' }).reply(status, body);
}

function interceptLlm(content: unknown, status = 200) {
	fetchMock.get(LLM_ORIGIN).intercept({ path: LLM_PATH, method: 'POST' }).reply(
		status,
		status === 200 ? llmBody(content) : String(content),
	);
}

async function openCache(): Promise<Cache> {
	return caches.open('feed-cache-v1');
}

async function seedRecord(id: string, url: string, overrides: Record<string, unknown> = {}) {
	await env.ARTICLE_CACHE.put(id, JSON.stringify({
		id,
		url,
		fetchedAt: '2026-04-16T10:00:00.000Z',
		articleTextHash: null,
		originalTitle: 'Original title',
		originalDescription: '<p>Original desc.</p>',
		refinedTitle: null,
		refinedDescription: null,
		status: 'pending_classification',
		retryCount: 0,
		...overrides,
	}));
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

beforeEach(async () => {
	// Clear KV between tests so state doesn't leak
	await env.ARTICLE_CACHE.delete(ARTICLE_ID_1);
	await env.ARTICLE_CACHE.delete(ARTICLE_ID_2);
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

// ─── runConcurrently ──────────────────────────────────────────────────────────

describe('runConcurrently', () => {
	it('runs all tasks when limit >= task count', async () => {
		const ran: number[] = [];
		const tasks = [0, 1, 2].map((i) => async () => { ran.push(i); });
		await runConcurrently(tasks, 10);
		expect(ran.sort()).toEqual([0, 1, 2]);
	});

	it('respects concurrency limit', async () => {
		let concurrent = 0;
		let maxConcurrent = 0;
		const tasks = Array.from({ length: 6 }, () => async () => {
			concurrent++;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			await new Promise<void>((r) => setTimeout(r, 10));
			concurrent--;
		});
		await runConcurrently(tasks, 3);
		expect(maxConcurrent).toBeLessThanOrEqual(3);
	});

	it('collects fulfilled and rejected results', async () => {
		const tasks = [
			async () => 'ok',
			async () => { throw new Error('fail'); },
		];
		const results = await runConcurrently(tasks, 2);
		expect(results[0].status).toBe('fulfilled');
		expect(results[1].status).toBe('rejected');
	});

	it('returns empty array for no tasks', async () => {
		const results = await runConcurrently([], 5);
		expect(results).toEqual([]);
	});
});

// ─── runPipeline — state machine ─────────────────────────────────────────────

describe('runPipeline', () => {
	it('happy path: clickbait articles get classified then refined', async () => {
		interceptRss();
		interceptLlm([{ id: ARTICLE_ID_1, clickbait: true }, { id: ARTICLE_ID_2, clickbait: true }]);
		interceptArticle(ARTICLE_PATH_1);
		interceptLlm({ title: 'Refined title 1', description: '<p>Refined desc 1</p>' });
		interceptArticle(ARTICLE_PATH_2);
		interceptLlm({ title: 'Refined title 2', description: '<p>Refined desc 2</p>' });

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const record = await kvGetArticle(env.ARTICLE_CACHE, ARTICLE_ID_1);
		expect(record?.status).toBe('refined');
		expect(record?.refinedTitle).toBe('Refined title 1');
	});

	it('not_clickbait: articles stay terminal with no refinement', async () => {
		interceptRss();
		interceptLlm([{ id: ARTICLE_ID_1, clickbait: false }, { id: ARTICLE_ID_2, clickbait: false }]);

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const record = await kvGetArticle(env.ARTICLE_CACHE, ARTICLE_ID_1);
		expect(record?.status).toBe('not_clickbait');
		expect(record?.refinedTitle).toBeNull();
	});

	it('keep_original: LLM refinement returns keep_original → llm_kept_original', async () => {
		interceptRss();
		interceptLlm([{ id: ARTICLE_ID_1, clickbait: true }, { id: ARTICLE_ID_2, clickbait: true }]);
		interceptArticle(ARTICLE_PATH_1);
		interceptLlm({ keep_original: true });
		interceptArticle(ARTICLE_PATH_2);
		interceptLlm({ keep_original: true });

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const record = await kvGetArticle(env.ARTICLE_CACHE, ARTICLE_ID_1);
		expect(record?.status).toBe('llm_kept_original');
		expect(record?.refinedTitle).toBeNull();
	});

	it('article fetch 404 → error_permanent immediately', async () => {
		interceptRss();
		interceptLlm([{ id: ARTICLE_ID_1, clickbait: true }, { id: ARTICLE_ID_2, clickbait: false }]);
		interceptArticle(ARTICLE_PATH_1, 404, '');

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const record = await kvGetArticle(env.ARTICLE_CACHE, ARTICLE_ID_1);
		expect(record?.status).toBe('error_permanent');
	});

	it('classification LLM failure → error_retryable_classification with retryCount 1', async () => {
		interceptRss();
		interceptLlm('Internal Server Error', 500);

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const record = await kvGetArticle(env.ARTICLE_CACHE, ARTICLE_ID_1);
		expect(record?.status).toBe('error_retryable_classification');
		expect(record?.retryCount).toBe(1);
	});

	it('after MAX_RETRIES classification failures → error_permanent', async () => {
		// Pre-seed records already at retryCount 2
		await seedRecord(ARTICLE_ID_1, ARTICLE_URL_1, { status: 'error_retryable_classification', retryCount: 2 });
		await seedRecord(ARTICLE_ID_2, ARTICLE_URL_2, { status: 'error_retryable_classification', retryCount: 2 });

		interceptRss();
		interceptLlm('Server Error', 500);

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const record = await kvGetArticle(env.ARTICLE_CACHE, ARTICLE_ID_1);
		expect(record?.status).toBe('error_permanent');
	});

	it('already terminal articles are not reprocessed', async () => {
		await seedRecord(ARTICLE_ID_1, ARTICLE_URL_1, { status: 'refined', refinedTitle: 'Already refined', refinedDescription: '<p>Done.</p>' });
		await seedRecord(ARTICLE_ID_2, ARTICLE_URL_2, { status: 'not_clickbait' });

		// Only RSS fetch — no LLM calls registered, so assertNoPendingInterceptors will catch any unexpected call
		interceptRss();

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const record = await kvGetArticle(env.ARTICLE_CACHE, ARTICLE_ID_1);
		expect(record?.status).toBe('refined');
		expect(record?.refinedTitle).toBe('Already refined');
	});

	it('upstream RSS fetch failure aborts pipeline gracefully without throwing', async () => {
		fetchMock.get(RSS_ORIGIN).intercept({ path: RSS_PATH }).reply(503, 'Service Unavailable');

		await expect(
			runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key'),
		).resolves.toBeUndefined();
	});
});

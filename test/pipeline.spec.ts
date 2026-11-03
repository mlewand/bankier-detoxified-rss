import { env, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, beforeEach, vi } from 'vitest';
import { runPipeline, runConcurrently, sha256Hex, MAX_REFINEMENTS_PER_RUN } from '../src/pipeline';
import { kvGetArticle, kvGetFeedIndex } from '../src/cache';

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
	// Suppress console.error from intentional error-path tests
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
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

	it('keep_original: LLM refinement returns keep_original -> llm_kept_original', async () => {
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

	it('article fetch 404 -> error_permanent immediately', async () => {
		interceptRss();
		interceptLlm([{ id: ARTICLE_ID_1, clickbait: true }, { id: ARTICLE_ID_2, clickbait: false }]);
		interceptArticle(ARTICLE_PATH_1, 404, '');

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const record = await kvGetArticle(env.ARTICLE_CACHE, ARTICLE_ID_1);
		expect(record?.status).toBe('error_permanent');
	});

	it('classification LLM failure -> error_retryable_classification with retryCount 1', async () => {
		interceptRss();
		interceptLlm('Internal Server Error', 500);

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const record = await kvGetArticle(env.ARTICLE_CACHE, ARTICLE_ID_1);
		expect(record?.status).toBe('error_retryable_classification');
		expect(record?.retryCount).toBe(1);
	});

	it('after MAX_RETRIES classification failures -> error_permanent', async () => {
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

	it('article in error_retryable_refinement is retried in next cron run', async () => {
		await seedRecord(ARTICLE_ID_1, ARTICLE_URL_1, { status: 'error_retryable_refinement', retryCount: 1 });
		await seedRecord(ARTICLE_ID_2, ARTICLE_URL_2, { status: 'not_clickbait' });

		interceptRss();
		interceptArticle(ARTICLE_PATH_1);
		interceptLlm({ title: 'Retry succeeded', description: '<p>Retry desc.</p>' });

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const record = await kvGetArticle(env.ARTICLE_CACHE, ARTICLE_ID_1);
		expect(record?.status).toBe('refined');
		expect(record?.refinedTitle).toBe('Retry succeeded');
	});

	it('article already in pending_refinement is refined without re-classifying', async () => {
		// Simulates a cron run where classification already happened but refinement hadn't yet
		await seedRecord(ARTICLE_ID_1, ARTICLE_URL_1, { status: 'pending_refinement' });
		await seedRecord(ARTICLE_ID_2, ARTICLE_URL_2, { status: 'not_clickbait' });

		interceptRss();
		// No classification LLM call expected — article is already classified
		interceptArticle(ARTICLE_PATH_1);
		interceptLlm({ title: 'Refined on second run', description: '<p>Refined.</p>' });

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const record = await kvGetArticle(env.ARTICLE_CACHE, ARTICLE_ID_1);
		expect(record?.status).toBe('refined');
		expect(record?.refinedTitle).toBe('Refined on second run');
	});

	it('LLM returns partial results omitting an article -> omitted article gets error_retryable_classification', async () => {
		interceptRss();
		// LLM only returns result for article 2, silently omitting article 1
		interceptLlm([{ id: ARTICLE_ID_2, clickbait: false }]);

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const record = await kvGetArticle(env.ARTICLE_CACHE, ARTICLE_ID_1);
		expect(record?.status).toBe('error_retryable_classification');
		expect(record?.retryCount).toBe(1);
	});

	it('article fetch throws network error -> error_retryable_refinement', async () => {
		interceptRss();
		interceptLlm([{ id: ARTICLE_ID_1, clickbait: true }, { id: ARTICLE_ID_2, clickbait: false }]);
		// Simulate a network-level throw (not a 4xx response)
		fetchMock.get(RSS_ORIGIN).intercept({ path: ARTICLE_PATH_1 }).replyWithError('Network failure');

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const record = await kvGetArticle(env.ARTICLE_CACHE, ARTICLE_ID_1);
		expect(record?.status).toBe('error_retryable_refinement');
		expect(record?.retryCount).toBe(1);
	});

	it('refinement LLM throws -> error_retryable_refinement', async () => {
		interceptRss();
		interceptLlm([{ id: ARTICLE_ID_1, clickbait: true }, { id: ARTICLE_ID_2, clickbait: false }]);
		interceptArticle(ARTICLE_PATH_1);
		// LLM call for refinement returns 500
		interceptLlm('Internal Server Error', 500);

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const record = await kvGetArticle(env.ARTICLE_CACHE, ARTICLE_ID_1);
		expect(record?.status).toBe('error_retryable_refinement');
		expect(record?.retryCount).toBe(1);
	});
});

// ─── sha256Hex ────────────────────────────────────────────────────────────────

describe('sha256Hex', () => {
	it('matches the standard SHA-256 test vector', async () => {
		expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});
});

// ─── runPipeline — skipping unchanged feeds ───────────────────────────────────

describe('runPipeline - unchanged feed short-circuit', () => {
	it('stores the RSS hash and pending-work flag in the feed index', async () => {
		interceptRss();
		interceptLlm([{ id: ARTICLE_ID_1, clickbait: false }, { id: ARTICLE_ID_2, clickbait: false }]);

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const index = await kvGetFeedIndex(env.ARTICLE_CACHE);
		expect(index?.rssHash).toBe(await sha256Hex(SAMPLE_RSS));
		expect(index?.hasPendingWork).toBe(false);
	});

	it('skips the run when the feed is unchanged and nothing is pending', async () => {
		interceptRss();
		interceptLlm([{ id: ARTICLE_ID_1, clickbait: false }, { id: ARTICLE_ID_2, clickbait: false }]);
		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');
		const before = await kvGetFeedIndex(env.ARTICLE_CACHE);

		// Second run: only the RSS fetch is expected
		interceptRss();
		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const after = await kvGetFeedIndex(env.ARTICLE_CACHE);
		expect(after).toEqual(before);
	});

	it('runs again on an unchanged feed when retryable work is pending', async () => {
		interceptRss();
		interceptLlm('Internal Server Error', 500);
		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');
		expect((await kvGetFeedIndex(env.ARTICLE_CACHE))?.hasPendingWork).toBe(true);

		interceptRss();
		interceptLlm([{ id: ARTICLE_ID_1, clickbait: false }, { id: ARTICLE_ID_2, clickbait: false }]);
		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		expect((await kvGetArticle(env.ARTICLE_CACHE, ARTICLE_ID_1))?.status).toBe('not_clickbait');
		expect((await kvGetFeedIndex(env.ARTICLE_CACHE))?.hasPendingWork).toBe(false);
	});

	it('runs when the feed content changed', async () => {
		interceptRss();
		interceptLlm([{ id: ARTICLE_ID_1, clickbait: false }, { id: ARTICLE_ID_2, clickbait: false }]);
		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const changedRss = SAMPLE_RSS.replace('<title>Bankier.pl</title>', '<title>Bankier.pl (changed)</title>');
		interceptRss(200, changedRss);
		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const index = await kvGetFeedIndex(env.ARTICLE_CACHE);
		expect(index?.channelTitle).toBe('Bankier.pl (changed)');
		expect(index?.rssHash).toBe(await sha256Hex(changedRss));
	});
});

// ─── runPipeline — refinement cap ─────────────────────────────────────────────

describe('runPipeline - refinement cap', () => {
	const COUNT = MAX_REFINEMENTS_PER_RUN + 2;
	const ids = Array.from({ length: COUNT }, (_, i) => String(9200000 + i));
	const pathFor = (id: string) => `/wiadomosc/Capped-${id}.html`;
	const rss = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
		<title>Bankier.pl</title><link>https://www.bankier.pl</link><description>W</description>
		${ids.map((id) => `<item><title>T ${id}</title><link>${RSS_ORIGIN}${pathFor(id)}</link><description>D</description><pubDate>Wed, 16 Apr 2026 10:00:00 +0200</pubDate></item>`).join('')}
	</channel></rss>`;

	it(`refines at most ${MAX_REFINEMENTS_PER_RUN} articles per run and leaves the rest pending`, async () => {
		interceptRss(200, rss);
		interceptLlm(ids.map((id) => ({ id, clickbait: true })));
		for (const id of ids.slice(0, MAX_REFINEMENTS_PER_RUN)) {
			interceptArticle(pathFor(id));
			interceptLlm({ title: 'Refined', description: '<p>R</p>' });
		}

		await runPipeline(env.ARTICLE_CACHE, await openCache(), RSS_URL, 'test-key');

		const statuses = await Promise.all(ids.map(async (id) => (await kvGetArticle(env.ARTICLE_CACHE, id))?.status));
		expect(statuses.filter((s) => s === 'refined')).toHaveLength(MAX_REFINEMENTS_PER_RUN);
		expect(statuses.filter((s) => s === 'pending_refinement')).toHaveLength(COUNT - MAX_REFINEMENTS_PER_RUN);
		expect((await kvGetFeedIndex(env.ARTICLE_CACHE))?.hasPendingWork).toBe(true);
	});
});

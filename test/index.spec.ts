import { env, SELF, fetchMock, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { kvPutArticle, kvPutFeedIndex, cachePutFeed } from '../src/cache';
import type { ArticleRecord } from '../src/types';
import type { FeedIndex } from '../src/cache';

const RSS_ORIGIN = 'https://www.bankier.pl';
const RSS_PATH = '/rss/wiadomosci.xml';
const RSS_URL = RSS_ORIGIN + RSS_PATH;
const LLM_ORIGIN = 'https://api.minimax.io';
const LLM_PATH = '/v1/chat/completions';
const CACHE_NAME = 'feed-cache-v1';

const ARTICLE_ID_1 = '9114821';
const ARTICLE_ID_2 = '9113525';

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Bankier.pl</title>
    <link>https://www.bankier.pl</link>
    <description>Wiadomosci</description>
    <item>
      <title>Clickbait title here</title>
      <link>https://www.bankier.pl/wiadomosc/article-${ARTICLE_ID_1}.html</link>
      <description>&lt;p&gt;Opis artykulu.&lt;/p&gt;</description>
      <pubDate>Wed, 16 Apr 2026 10:00:00 +0200</pubDate>
      <guid>https://www.bankier.pl/wiadomosc/article-${ARTICLE_ID_1}.html</guid>
    </item>
    <item>
      <title>Normal title</title>
      <link>https://www.bankier.pl/wiadomosc/article-${ARTICLE_ID_2}.html</link>
      <description>Opis drugiego artykulu.</description>
      <pubDate>Wed, 16 Apr 2026 09:00:00 +0200</pubDate>
      <guid>https://www.bankier.pl/wiadomosc/article-${ARTICLE_ID_2}.html</guid>
    </item>
  </channel>
</rss>`;

const RECORD_1: ArticleRecord = {
	id: ARTICLE_ID_1,
	url: `https://www.bankier.pl/wiadomosc/article-${ARTICLE_ID_1}.html`,
	fetchedAt: '2026-04-16T10:00:00.000Z',
	articleTextHash: null,
	originalTitle: 'Clickbait title here',
	originalDescription: '<p>Opis artykulu.</p>',
	refinedTitle: 'Clear refined title',
	refinedDescription: '<p>Refined description.</p>',
	status: 'refined',
	retryCount: 0,
};

const RECORD_2: ArticleRecord = {
	id: ARTICLE_ID_2,
	url: `https://www.bankier.pl/wiadomosc/article-${ARTICLE_ID_2}.html`,
	fetchedAt: '2026-04-16T09:00:00.000Z',
	articleTextHash: null,
	originalTitle: 'Normal title',
	originalDescription: 'Opis drugiego artykulu.',
	refinedTitle: null,
	refinedDescription: null,
	status: 'not_clickbait',
	retryCount: 0,
};

const FEED_INDEX: FeedIndex = {
	channelTitle: 'Bankier.pl',
	channelLink: 'https://www.bankier.pl',
	channelDescription: 'Wiadomosci',
	itemIds: [ARTICLE_ID_1, ARTICLE_ID_2],
	updatedAt: '2026-04-16T10:00:00.000Z',
};

async function openFeedCache(): Promise<Cache> {
	return caches.open(CACHE_NAME);
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

beforeEach(async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	await env.ARTICLE_CACHE.delete(ARTICLE_ID_1);
	await env.ARTICLE_CACHE.delete(ARTICLE_ID_2);
	await env.ARTICLE_CACHE.delete('__feed_index');
	const cache = await openFeedCache();
	await cache.delete(RSS_URL);
});

afterEach(() => {
	vi.restoreAllMocks();
	fetchMock.assertNoPendingInterceptors();
});

// ─── fetch handler ────────────────────────────────────────────────────────────

describe('fetch handler', () => {
	it('serves XML from L2 cache when available', async () => {
		const cache = await openFeedCache();
		await cachePutFeed(cache, RSS_URL, '<rss><channel><title>Cached</title></channel></rss>');

		const response = await SELF.fetch('https://example.com/');

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('rss+xml');
		expect(await response.text()).toContain('Cached');
	});

	it('rebuilds feed from KV feed index on L2 cache miss', async () => {
		await kvPutFeedIndex(env.ARTICLE_CACHE, FEED_INDEX);
		await kvPutArticle(env.ARTICLE_CACHE, RECORD_1);
		await kvPutArticle(env.ARTICLE_CACHE, RECORD_2);

		const response = await SELF.fetch('https://example.com/');

		expect(response.status).toBe(200);
		const xml = await response.text();
		// Refined title should appear for article 1
		expect(xml).toContain('Clear refined title');
		// Original title for article 2 (not_clickbait, no refinement)
		expect(xml).toContain('Normal title');
	});

	it('populates L2 cache after KV rebuild so next request is a cache hit', async () => {
		await kvPutFeedIndex(env.ARTICLE_CACHE, FEED_INDEX);
		await kvPutArticle(env.ARTICLE_CACHE, RECORD_1);
		await kvPutArticle(env.ARTICLE_CACHE, RECORD_2);

		// First request — cache miss, rebuilds from KV
		const ctx = createExecutionContext();
		await worker.fetch(new Request('https://example.com/'), env, ctx);
		await waitOnExecutionContext(ctx);

		// Second request — should now be served from cache without needing KV
		await env.ARTICLE_CACHE.delete(ARTICLE_ID_1);
		await env.ARTICLE_CACHE.delete(ARTICLE_ID_2);
		await env.ARTICLE_CACHE.delete('__feed_index');

		const response = await SELF.fetch('https://example.com/');
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Clear refined title');
	});

	it('omits items whose KV record is missing from the feed index', async () => {
		// Feed index lists two IDs but only one has a KV record
		await kvPutFeedIndex(env.ARTICLE_CACHE, FEED_INDEX);
		await kvPutArticle(env.ARTICLE_CACHE, RECORD_2); // RECORD_1 deliberately absent

		const response = await SELF.fetch('https://example.com/');
		const xml = await response.text();

		expect(xml).toContain('Normal title');
		expect(xml).not.toContain('Clear refined title');
	});

	it('cold-start: fetches upstream RSS when KV has no feed index', async () => {
		fetchMock.get(RSS_ORIGIN).intercept({ path: RSS_PATH }).reply(200, SAMPLE_RSS);

		const response = await SELF.fetch('https://example.com/');

		expect(response.status).toBe(200);
		const xml = await response.text();
		expect(xml).toContain('Clickbait title here');
	});

	it('error fallback: proxies to upstream when feed rebuild fails', async () => {
		// First fetch (inside fetchRss) throws; second fetch (fallback) returns upstream XML
		fetchMock.get(RSS_ORIGIN).intercept({ path: RSS_PATH }).replyWithError('Upstream unavailable');
		fetchMock.get(RSS_ORIGIN).intercept({ path: RSS_PATH }).reply(200, SAMPLE_RSS);

		const response = await SELF.fetch('https://example.com/');

		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Bankier.pl');
	});
});

// ─── scheduled handler ────────────────────────────────────────────────────────

describe('scheduled handler', () => {
	it('runs pipeline and writes article records to KV', async () => {
		fetchMock.get(RSS_ORIGIN).intercept({ path: RSS_PATH }).reply(200, SAMPLE_RSS);
		fetchMock.get(LLM_ORIGIN).intercept({ path: LLM_PATH, method: 'POST' }).reply(200,
			JSON.stringify({ choices: [{ message: { content: JSON.stringify([
				{ id: ARTICLE_ID_1, clickbait: false },
				{ id: ARTICLE_ID_2, clickbait: false },
			]) } }] }),
		);

		const ctx = createExecutionContext();
		await worker.scheduled({} as ScheduledController, env, ctx);
		await waitOnExecutionContext(ctx);

		const raw = await env.ARTICLE_CACHE.get(ARTICLE_ID_1);
		expect(raw).not.toBeNull();
		const record = JSON.parse(raw!);
		expect(record.status).toBe('not_clickbait');
	});
});

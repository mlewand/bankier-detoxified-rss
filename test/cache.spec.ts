import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { getConfig } from '../src/config';
import {
	kvGetArticle,
	kvPutArticle,
	kvGetMany,
	kvGetFeedIndex,
	kvPutFeedIndex,
	cacheGetFeed,
	cachePutFeed,
} from '../src/cache';
import type { ArticleRecord } from '../src/types';
import type { FeedIndex } from '../src/cache';

const KV = env.ARTICLE_CACHE;

const RECORD: ArticleRecord = {
	id: '9114821',
	url: 'https://www.bankier.pl/wiadomosc/article-9114821.html',
	fetchedAt: '2026-04-16T10:00:00.000Z',
	articleTextHash: null,
	originalTitle: 'Original title',
	originalDescription: '<p>Original desc.</p>',
	refinedTitle: 'Refined title',
	refinedDescription: '<p>Refined desc.</p>',
	status: 'refined',
	retryCount: 0,
};

const FEED_INDEX: FeedIndex = {
	channelTitle: 'Bankier.pl',
	channelLink: 'https://www.bankier.pl',
	channelDescription: 'Wiadomosci',
	itemIds: ['9114821', '9113525'],
	updatedAt: '2026-04-16T10:00:00.000Z',
};

beforeEach(async () => {
	await KV.delete('9114821');
	await KV.delete('9113525');
	await KV.delete('__feed_index');
});

// ─── kvGetArticle ─────────────────────────────────────────────────────────────

describe('cache.ts - kvGetArticle', () => {
	it('returns null when key does not exist', async () => {
		const result = await kvGetArticle(KV, 'nonexistent');
		expect(result).toBeNull();
	});

	it('returns parsed record when key exists', async () => {
		await KV.put('9114821', JSON.stringify(RECORD));
		const result = await kvGetArticle(KV, '9114821');
		expect(result).toEqual(RECORD);
	});

	it('returns null when stored value is malformed JSON', async () => {
		await KV.put('9114821', 'not valid json {{{');
		const result = await kvGetArticle(KV, '9114821');
		expect(result).toBeNull();
	});
});

// ─── kvPutArticle ─────────────────────────────────────────────────────────────

describe('cache.ts - kvPutArticle', () => {
	it('stores record and retrieves it correctly', async () => {
		await kvPutArticle(KV, RECORD);
		const result = await kvGetArticle(KV, '9114821');
		expect(result).toEqual(RECORD);
	});
});

// ─── kvGetMany ────────────────────────────────────────────────────────────────

describe('cache.ts - kvGetMany', () => {
	it('returns a map containing only found records', async () => {
		await KV.put('9114821', JSON.stringify(RECORD));
		const map = await kvGetMany(KV, ['9114821', '9113525']);
		expect(map.size).toBe(1);
		expect(map.get('9114821')).toEqual(RECORD);
		expect(map.has('9113525')).toBe(false);
	});

	it('returns empty map when no IDs match', async () => {
		const map = await kvGetMany(KV, ['nonexistent']);
		expect(map.size).toBe(0);
	});

	it('returns empty map for empty ID list', async () => {
		const map = await kvGetMany(KV, []);
		expect(map.size).toBe(0);
	});
});

// ─── kvPutFeedIndex / kvGetFeedIndex ─────────────────────────────────────────

describe('cache.ts - kvPutFeedIndex / kvGetFeedIndex', () => {
	it('returns null when feed index does not exist', async () => {
		const result = await kvGetFeedIndex(KV);
		expect(result).toBeNull();
	});

	it('stores and retrieves feed index correctly', async () => {
		await kvPutFeedIndex(KV, FEED_INDEX);
		const result = await kvGetFeedIndex(KV);
		expect(result).toEqual(FEED_INDEX);
	});

	it('returns null when stored feed index is malformed JSON', async () => {
		await KV.put('__feed_index', 'not json');
		const result = await kvGetFeedIndex(KV);
		expect(result).toBeNull();
	});
});

// ─── cacheGetFeed / cachePutFeed ─────────────────────────────────────────────

describe('cache.ts - cacheGetFeed / cachePutFeed', () => {
	const CACHE_KEY = 'https://www.bankier.pl/rss/wiadomosci.xml';
	const FEED_XML = '<?xml version="1.0"?><rss><channel><title>Test</title></channel></rss>';

	async function openCache() {
		return caches.open('test-feed-cache');
	}

	it('returns null when nothing is cached', async () => {
		const cache = await openCache();
		const result = await cacheGetFeed(cache, CACHE_KEY);
		expect(result).toBeNull();
	});

	it('stores and retrieves feed XML correctly', async () => {
		const cache = await openCache();
		await cachePutFeed(cache, CACHE_KEY, FEED_XML);
		const result = await cacheGetFeed(cache, CACHE_KEY);
		expect(result).toBe(FEED_XML);
	});
});

// ─── getConfig ────────────────────────────────────────────────────────────────

describe('config.ts - getConfig', () => {
	it('reads LLM_API_KEY and UPSTREAM_RSS_URL from env', () => {
		const config = getConfig(env);
		expect(config.llmApiKey).toBe(env.LLM_API_KEY);
		expect(config.upstreamRssUrl).toBe(env.UPSTREAM_RSS_URL);
	});
});

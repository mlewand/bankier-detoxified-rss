import type { ArticleRecord } from './types';

const ARTICLE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const FEED_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const FEED_INDEX_KEY = '__feed_index';

export interface FeedIndex {
	channelTitle: string;
	channelLink: string;
	channelDescription: string;
	itemIds: string[];
	updatedAt: string;
}

// ─── Article KV helpers ───────────────────────────────────────────────────────

export async function kvGetArticle(kv: KVNamespace, id: string): Promise<ArticleRecord | null> {
	const raw = await kv.get(id);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as ArticleRecord;
	} catch {
		return null;
	}
}

export async function kvPutArticle(kv: KVNamespace, record: ArticleRecord): Promise<void> {
	await kv.put(record.id, JSON.stringify(record), { expirationTtl: ARTICLE_TTL_SECONDS });
}

export async function kvGetMany(kv: KVNamespace, ids: string[]): Promise<Map<string, ArticleRecord>> {
	const records = await Promise.all(ids.map((id) => kvGetArticle(kv, id)));
	const map = new Map<string, ArticleRecord>();
	for (let i = 0; i < ids.length; i++) {
		const r = records[i];
		if (r) map.set(ids[i], r);
	}
	return map;
}

// ─── Feed index KV helpers ────────────────────────────────────────────────────

export async function kvPutFeedIndex(kv: KVNamespace, index: FeedIndex): Promise<void> {
	await kv.put(FEED_INDEX_KEY, JSON.stringify(index), { expirationTtl: FEED_TTL_SECONDS });
}

export async function kvGetFeedIndex(kv: KVNamespace): Promise<FeedIndex | null> {
	const raw = await kv.get(FEED_INDEX_KEY);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as FeedIndex;
	} catch {
		return null;
	}
}

// ─── L2 Cache API helpers ─────────────────────────────────────────────────────

export async function cacheGetFeed(cache: Cache, cacheKey: string): Promise<string | null> {
	const resp = await cache.match(cacheKey);
	if (!resp) return null;
	return resp.text();
}

export async function cachePutFeed(cache: Cache, cacheKey: string, xml: string): Promise<void> {
	const resp = new Response(xml, {
		headers: {
			'Content-Type': 'application/rss+xml; charset=utf-8',
			'Cache-Control': `public, max-age=180`,
		},
	});
	await cache.put(cacheKey, resp);
}

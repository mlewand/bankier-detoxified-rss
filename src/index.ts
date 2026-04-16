import { runPipeline } from './pipeline';
import { fetchRss } from './bankier';
import { kvGetMany, kvGetFeedIndex, cacheGetFeed, cachePutFeed } from './cache';
import { buildFeedXml } from './feed';
import { getConfig } from './config';

const CACHE_NAME = 'feed-cache-v1';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { upstreamRssUrl } = getConfig(env);
		const cache = await caches.open(CACHE_NAME);

		// 1. Serve from L2 cache if present
		const cached = await cacheGetFeed(cache, upstreamRssUrl);
		if (cached) {
			return new Response(cached, {
				headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
			});
		}

		// 2. L2 miss: rebuild from KV only (no LLM, no bankier article fetches)
		try {
			// Try to use the stored feed index (written by cron) to avoid upstream RSS fetch
			const feedIndex = await kvGetFeedIndex(env.ARTICLE_CACHE);

			let channel;
			if (feedIndex) {
				// Reconstruct a minimal RssChannel from KV records
				const records = await kvGetMany(env.ARTICLE_CACHE, feedIndex.itemIds);
				channel = {
					title: feedIndex.channelTitle,
					link: feedIndex.channelLink,
					description: feedIndex.channelDescription,
					items: feedIndex.itemIds
						.map((id) => {
							const r = records.get(id);
							if (!r) return null;
							return {
								id: r.id,
								url: r.url,
								title: r.originalTitle,
								description: r.originalDescription,
								pubDate: r.fetchedAt,
								guid: r.url,
							};
						})
						.filter((i): i is NonNullable<typeof i> => i !== null),
				};
				const xml = buildFeedXml(channel, records);
				ctx.waitUntil(cachePutFeed(cache, upstreamRssUrl, xml));
				return new Response(xml, {
					headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
				});
			}

			// 3. Cold-start fallback: fetch upstream RSS, use any KV refinements we have
			channel = await fetchRss(upstreamRssUrl);
			const records = await kvGetMany(env.ARTICLE_CACHE, channel.items.map((i) => i.id));
			const xml = buildFeedXml(channel, records);
			ctx.waitUntil(cachePutFeed(cache, upstreamRssUrl, xml));
			return new Response(xml, {
				headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
			});
		} catch (err) {
			console.error('Fetch handler: feed rebuild failed, falling back to upstream', err);
			return fetch(upstreamRssUrl);
		}
	},

	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const { upstreamRssUrl, llmApiKey } = getConfig(env);
		const cache = await caches.open(CACHE_NAME);
		ctx.waitUntil(runPipeline(env.ARTICLE_CACHE, cache, upstreamRssUrl, llmApiKey, env.ANALYTICS));
	},
} satisfies ExportedHandler<Env>;

import type { ArticleRecord, ArticleStatus } from './types';
import { fetchRss, fetchArticleText, type RssChannel } from './bankier';
import { kvGetMany, kvPutArticle, kvPutFeedIndex, cachePutFeed } from './cache';
import { classifyBatch, refineArticle, type ArticleInput } from './llm';
import { buildFeedXml } from './feed';

const MAX_RETRIES = 3;
const REFINEMENT_CONCURRENCY = 5;

const TERMINAL_STATUSES: ArticleStatus[] = ['not_clickbait', 'refined', 'llm_kept_original', 'error_permanent'];

function isTerminal(status: ArticleStatus | undefined): boolean {
	return status !== undefined && (TERMINAL_STATUSES as string[]).includes(status);
}

function needsClassification(record: ArticleRecord | undefined): boolean {
	if (!record) return true;
	if (record.status === 'pending_classification') return true;
	if (record.status === 'error_retryable_classification' && record.retryCount < MAX_RETRIES) return true;
	return false;
}

function needsRefinement(record: ArticleRecord | undefined): boolean {
	if (!record) return false;
	if (record.status === 'pending_refinement') return true;
	if (record.status === 'error_retryable_refinement' && record.retryCount < MAX_RETRIES) return true;
	return false;
}

export async function runConcurrently<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<PromiseSettledResult<T>[]> {
	const results: PromiseSettledResult<T>[] = new Array(tasks.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (true) {
			const i = nextIndex++;
			if (i >= tasks.length) return;
			try {
				results[i] = { status: 'fulfilled', value: await tasks[i]() };
			} catch (err) {
				results[i] = { status: 'rejected', reason: err };
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
	return results;
}

export async function runPipeline(
	kv: KVNamespace,
	cache: Cache,
	upstreamRssUrl: string,
	llmApiKey: string,
): Promise<void> {
	// 1. Fetch upstream RSS
	let channel: RssChannel;
	try {
		channel = await fetchRss(upstreamRssUrl);
	} catch (err) {
		console.error('Pipeline: failed to fetch upstream RSS', err);
		return;
	}

	const allIds = channel.items.map((i) => i.id);
	const now = new Date().toISOString();

	// Persist the current feed structure so the fetch handler can rebuild without upstream
	await kvPutFeedIndex(kv, {
		channelTitle: channel.title,
		channelLink: channel.link,
		channelDescription: channel.description,
		itemIds: allIds,
		updatedAt: now,
	});

	// 2. Batch read KV
	const records = await kvGetMany(kv, allIds);

	// 3. Partition articles into work queues
	const toClassify: ArticleInput[] = [];
	const toRefine: string[] = [];

	for (const item of channel.items) {
		const record = records.get(item.id);

		if (isTerminal(record?.status)) continue;

		if (needsClassification(record)) {
			toClassify.push({ id: item.id, title: item.title, description: item.description });

			// Create a KV record immediately so retryCount tracking works
			if (!record) {
				const newRecord: ArticleRecord = {
					id: item.id,
					url: item.url,
					fetchedAt: now,
					articleTextHash: null,
					originalTitle: item.title,
					originalDescription: item.description,
					refinedTitle: null,
					refinedDescription: null,
					status: 'pending_classification',
					retryCount: 0,
				};
				records.set(item.id, newRecord);
				await kvPutArticle(kv, newRecord);
			}
		} else if (needsRefinement(record)) {
			toRefine.push(item.id);
		}
	}

	// 4. Stage 1 — batch classification
	if (toClassify.length > 0) {
		let classifyResults: { id: string; clickbait: boolean }[] = [];

		try {
			classifyResults = await classifyBatch(llmApiKey, toClassify);
		} catch (err) {
			console.error('Pipeline: Stage 1 batch classification failed', err);
			// Mark all articles in this batch as retryable failures
			for (const { id } of toClassify) {
				const record = records.get(id);
				if (!record) continue;
				record.retryCount += 1;
				record.status = record.retryCount >= MAX_RETRIES ? 'error_permanent' : 'error_retryable_classification';
				await kvPutArticle(kv, record);
			}
		}

		if (classifyResults.length > 0) {
			const resultMap = new Map(classifyResults.map((r) => [r.id, r.clickbait]));
			for (const { id } of toClassify) {
				const record = records.get(id);
				if (!record) continue;

				const clickbait = resultMap.get(id);
				if (clickbait === undefined) {
					// LLM didn't return a result for this article
					record.retryCount += 1;
					record.status = record.retryCount >= MAX_RETRIES ? 'error_permanent' : 'error_retryable_classification';
				} else if (clickbait) {
					record.status = 'pending_refinement';
					toRefine.push(id);
				} else {
					record.status = 'not_clickbait';
				}
				await kvPutArticle(kv, record);
			}
		}
	}

	// 5. Stage 2 — per-article refinement (deduped, capped concurrency)
	const uniqueToRefine = [...new Set(toRefine)];

	if (uniqueToRefine.length > 0) {
		const tasks = uniqueToRefine.map((id) => async () => {
			const record = records.get(id);
			if (!record) return;

			const item = channel.items.find((i) => i.id === id);
			if (!item) return;

			// Fetch full article HTML and extract text
			let articleText: string;
			try {
				const { text, statusCode } = await fetchArticleText(item.url);
				if (statusCode === 404 || statusCode === 410) {
					record.status = 'error_permanent';
					await kvPutArticle(kv, record);
					return;
				}
				articleText = text;
			} catch (err) {
				console.error(`Pipeline: failed to fetch article ${id}`, err);
				record.retryCount += 1;
				record.status = record.retryCount >= MAX_RETRIES ? 'error_permanent' : 'error_retryable_refinement';
				await kvPutArticle(kv, record);
				return;
			}

			// LLM refinement
			try {
				const result = await refineArticle(llmApiKey, {
					title: record.originalTitle,
					description: record.originalDescription,
					text: articleText,
				});

				if ('keep_original' in result && result.keep_original) {
					record.status = 'llm_kept_original';
					record.refinedTitle = null;
					record.refinedDescription = null;
				} else {
					const refined = result as { title: string; description: string };
					record.status = 'refined';
					record.refinedTitle = refined.title;
					record.refinedDescription = refined.description ?? null;
				}
			} catch (err) {
				console.error(`Pipeline: refinement failed for article ${id}`, err);
				record.retryCount += 1;
				record.status = record.retryCount >= MAX_RETRIES ? 'error_permanent' : 'error_retryable_refinement';
			}

			await kvPutArticle(kv, record);
		});

		await runConcurrently(tasks, REFINEMENT_CONCURRENCY);
	}

	// 6. Rebuild feed XML and write to L2 cache
	const feedXml = buildFeedXml(channel, records);
	await cachePutFeed(cache, upstreamRssUrl, feedXml);
}

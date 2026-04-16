import { XMLParser } from 'fast-xml-parser';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

export interface RssItem {
	id: string;
	url: string;
	title: string;
	description: string;
	pubDate: string;
	guid: string;
}

export interface RssChannel {
	title: string;
	link: string;
	description: string;
	items: RssItem[];
}

const ARTICLE_ID_RE = /-(\d+)\.html/;

function extractId(url: string): string | null {
	const m = url.match(ARTICLE_ID_RE);
	return m ? m[1] : null;
}

function coerceString(val: unknown): string {
	if (val === null || val === undefined) return '';
	if (typeof val === 'string') return val;
	if (typeof val === 'object' && val !== null && '#text' in val) return String((val as Record<string, unknown>)['#text']);
	return String(val);
}

export function parseRss(xml: string): RssChannel {
	const parser = new XMLParser({
		ignoreAttributes: false,
		isArray: (name) => name === 'item',
		processEntities: true,
	});
	const doc = parser.parse(xml);
	const channel = doc?.rss?.channel;
	if (!channel) throw new Error('Invalid RSS: missing rss.channel');

	const rawItems: unknown[] = channel.item ?? [];
	const items: RssItem[] = [];

	for (const raw of rawItems) {
		const r = raw as Record<string, unknown>;
		// <link> in RSS is the article URL; <guid> is sometimes the same or a permalink
		const url = coerceString(r['link'] ?? r['guid'] ?? '');
		const id = extractId(url);
		if (!id) continue;
		items.push({
			id,
			url,
			title: coerceString(r['title']),
			description: coerceString(r['description']),
			pubDate: coerceString(r['pubDate']),
			guid: coerceString(r['guid'] ?? r['link'] ?? url),
		});
	}

	return {
		title: coerceString(channel.title),
		link: coerceString(channel.link),
		description: coerceString(channel.description),
		items,
	};
}

export async function fetchRss(url: string): Promise<RssChannel> {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`RSS fetch failed: ${resp.status} ${resp.statusText}`);
	const xml = await resp.text();
	return parseRss(xml);
}

export interface ArticleFetchResult {
	text: string;
	statusCode: number;
}

export async function fetchArticleText(url: string): Promise<ArticleFetchResult> {
	const resp = await fetch(url, {
		headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BankierRssProxy/1.0)' },
	});

	if (!resp.ok) {
		return { text: '', statusCode: resp.status };
	}

	const html = await resp.text();
	const { document } = parseHTML(html);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const reader = new Readability(document as any);
	const article = reader.parse();
	const text = article?.textContent?.trim() ?? '';

	return { text, statusCode: resp.status };
}

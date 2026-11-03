import { XMLParser } from 'fast-xml-parser';

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

/** Fetches the raw upstream RSS XML without parsing it. */
export async function fetchRssXml(url: string): Promise<string> {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`RSS fetch failed: ${resp.status} ${resp.statusText}`);
	return resp.text();
}

export async function fetchRss(url: string): Promise<RssChannel> {
	return parseRss(await fetchRssXml(url));
}

export interface ArticleFetchResult {
	text: string;
	statusCode: number;
}

// Article body text is taken from these elements. If the page has no <article>
// (or it contains none of them), every <p> on the page is used instead.
export const ARTICLE_TEXT_SELECTOR = 'article p, article h2, article h3';
export const FALLBACK_TEXT_SELECTOR = 'p';

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	ndash: '–',
	mdash: '—',
	hellip: '…',
	bdquo: '„',
	ldquo: '“',
	rdquo: '”',
};

export function decodeEntities(str: string): string {
	return str.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ent: string) => {
		if (ent[0] === '#') {
			const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return NAMED_ENTITIES[ent.toLowerCase()] ?? match;
	});
}

/** Collects the text of each matched element as one normalized line. */
class TextCollector {
	private readonly lines: string[] = [];
	private current = '';

	element(el: Element): void {
		this.flush();
		el.onEndTag(() => this.flush());
	}

	text(chunk: Text): void {
		this.current += chunk.text;
	}

	result(): string {
		this.flush();
		return this.lines.join('\n');
	}

	private flush(): void {
		const line = decodeEntities(this.current).replace(/\s+/g, ' ').trim();
		if (line) this.lines.push(line);
		this.current = '';
	}
}

/**
 * Fetches an article page and extracts its body text with HTMLRewriter.
 *
 * HTMLRewriter is native to the Workers runtime and streams the page without
 * building a DOM, which keeps this within the Free plan's CPU budget
 * (linkedom + Readability cost 100+ ms of CPU per article).
 */
export async function fetchArticleText(url: string): Promise<ArticleFetchResult> {
	const resp = await fetch(url, {
		headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BankierRssProxy/1.0)' },
	});

	if (!resp.ok) {
		return { text: '', statusCode: resp.status };
	}

	const article = new TextCollector();
	const fallback = new TextCollector();
	await new HTMLRewriter()
		.on(ARTICLE_TEXT_SELECTOR, article)
		.on(FALLBACK_TEXT_SELECTOR, fallback)
		.transform(resp)
		.arrayBuffer();

	const text = article.result() || fallback.result();
	return { text, statusCode: resp.status };
}

import { describe, it, expect } from 'vitest';
import { parseRss, fetchRss, fetchArticleText } from '../src/bankier';

const FIXTURE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Bankier.pl - Wiadomości</title>
    <link>https://www.bankier.pl</link>
    <description>Najnowsze wiadomości finansowe</description>
    <item>
      <title>Gdzie najtrudniej o pracę? Te województwa odnotowały największy odpływ ogłoszeń</title>
      <link>https://www.bankier.pl/wiadomosc/Gdzie-najtrudniej-o-prace-9114821.html</link>
      <description>&lt;p&gt;&lt;img width="945" height="560" src="http://galeria.bankier.pl/img.jpg" alt="" /&gt;Od kwietnia 2025 r. systematycznie maleje liczba ofert pracy.&lt;/p&gt;</description>
      <pubDate>Wed, 16 Apr 2026 10:00:00 +0200</pubDate>
      <guid>https://www.bankier.pl/wiadomosc/Gdzie-najtrudniej-o-prace-9114821.html</guid>
    </item>
    <item>
      <title>Nest Bank stawia na lokaty walutowe. Do 2,25% na depozycie w euro</title>
      <link>https://www.bankier.pl/wiadomosc/Nest-Bank-lokaty-walutowe-9113525.html</link>
      <description>Nest Bank wprowadza nowe lokaty walutowe z oprocentowaniem do 2,25% w euro.</description>
      <pubDate>Wed, 16 Apr 2026 09:00:00 +0200</pubDate>
      <guid>https://www.bankier.pl/wiadomosc/Nest-Bank-lokaty-walutowe-9113525.html</guid>
    </item>
    <item>
      <title>Artykuł bez ID w URL</title>
      <link>https://www.bankier.pl/wiadomosc/bez-id.html</link>
      <description>Ten artykuł nie ma ID w URL i powinien być pominięty.</description>
      <pubDate>Wed, 16 Apr 2026 08:00:00 +0200</pubDate>
      <guid>https://www.bankier.pl/wiadomosc/bez-id.html</guid>
    </item>
    <item>
      <title>Tytuł z &amp; znakami &lt;specjalnymi&gt;</title>
      <link>https://www.bankier.pl/wiadomosc/special-chars-9999999.html</link>
      <description>Opis z &amp;amp; encjami.</description>
      <pubDate>Wed, 16 Apr 2026 07:00:00 +0200</pubDate>
      <guid>https://www.bankier.pl/wiadomosc/special-chars-9999999.html</guid>
    </item>
  </channel>
</rss>`;

// Minimal article HTML for Readability extraction
const SAMPLE_ARTICLE_HTML = `<!DOCTYPE html>
<html>
<head><title>Test Article</title></head>
<body>
  <article>
    <h1>Artykuł testowy</h1>
    <p>Pierwsze zdanie artykułu zawierające istotne informacje.</p>
    <p>Drugie zdanie z kolejnymi faktami finansowymi.</p>
  </article>
</body>
</html>`;

describe('bankier.ts - parseRss', () => {
	it('parses channel metadata', () => {
		const channel = parseRss(FIXTURE_RSS);
		expect(channel.title).toBe('Bankier.pl - Wiadomości');
		expect(channel.link).toBe('https://www.bankier.pl');
		expect(channel.description).toBe('Najnowsze wiadomości finansowe');
	});

	it('extracts items with numeric IDs', () => {
		const channel = parseRss(FIXTURE_RSS);
		// fixture has 4 items but one has no ID in URL → 3 parsed
		expect(channel.items).toHaveLength(3);
	});

	it('extracts correct IDs from URLs', () => {
		const channel = parseRss(FIXTURE_RSS);
		expect(channel.items[0].id).toBe('9114821');
		expect(channel.items[1].id).toBe('9113525');
		expect(channel.items[2].id).toBe('9999999');
	});

	it('skips items whose URL has no numeric ID', () => {
		const channel = parseRss(FIXTURE_RSS);
		const ids = channel.items.map((i) => i.id);
		expect(ids).not.toContain(undefined);
		expect(ids).not.toContain(null);
		// the "bez-id" item should be absent
		expect(channel.items.find((i) => i.url.includes('bez-id'))).toBeUndefined();
	});

	it('decodes HTML entities in description', () => {
		const channel = parseRss(FIXTURE_RSS);
		// first item description has &lt;p&gt;&lt;img ... - should come back as HTML tags
		expect(channel.items[0].description).toContain('<p>');
		expect(channel.items[0].description).toContain('<img');
	});

	it('throws on missing rss.channel', () => {
		expect(() => parseRss('<notRss/>')).toThrow('Invalid RSS');
	});

	it('returns empty items array when channel has no items', () => {
		const xml = `<?xml version="1.0"?><rss><channel><title>T</title><link>L</link><description>D</description></channel></rss>`;
		const channel = parseRss(xml);
		expect(channel.items).toHaveLength(0);
	});

	it('returns empty string for missing fields (coerceString with undefined)', () => {
		// An item with no <description> or <pubDate> → coerceString(undefined) → ''
		const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
			<title>T</title><link>https://www.bankier.pl</link><description>D</description>
			<item>
				<title>Title</title>
				<link>https://www.bankier.pl/wiadomosc/article-9114821.html</link>
				<guid>https://www.bankier.pl/wiadomosc/article-9114821.html</guid>
			</item>
		</channel></rss>`;
		const channel = parseRss(xml);
		expect(channel.items[0].description).toBe('');
		expect(channel.items[0].pubDate).toBe('');
	});

	it('skips item when both <link> and <guid> are absent (url falls back to empty string)', () => {
		// bankier.ts:51 — r['link'] ?? r['guid'] ?? '' → '' → no numeric id → item skipped
		const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
			<title>T</title><link>https://www.bankier.pl</link><description>D</description>
			<item>
				<title>No URL at all</title>
				<description>Desc</description>
			</item>
		</channel></rss>`;
		const channel = parseRss(xml);
		expect(channel.items).toHaveLength(0);
	});

	it('uses <guid> as URL when <link> element is absent', () => {
		// bankier.ts:51 — r['link'] ?? r['guid'] fallback
		const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
			<title>T</title><link>https://www.bankier.pl</link><description>D</description>
			<item>
				<title>Title</title>
				<description>Desc</description>
				<pubDate>Wed, 16 Apr 2026 10:00:00 +0200</pubDate>
				<guid>https://www.bankier.pl/wiadomosc/article-9114821.html</guid>
			</item>
		</channel></rss>`;
		const channel = parseRss(xml);
		expect(channel.items).toHaveLength(1);
		expect(channel.items[0].id).toBe('9114821');
		expect(channel.items[0].url).toContain('9114821');
	});

	it('uses <link> as guid when <guid> element is absent', () => {
		// bankier.ts:60 — r['guid'] ?? r['link'] fallback
		const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
			<title>T</title><link>https://www.bankier.pl</link><description>D</description>
			<item>
				<title>Title</title>
				<link>https://www.bankier.pl/wiadomosc/article-9114821.html</link>
				<description>Desc</description>
				<pubDate>Wed, 16 Apr 2026 10:00:00 +0200</pubDate>
			</item>
		</channel></rss>`;
		const channel = parseRss(xml);
		expect(channel.items[0].guid).toContain('9114821');
	});

	it('coerces a numeric guid to string (fast-xml-parser parses bare numbers as number type)', () => {
		// fast-xml-parser parses a field like <guid>9114821</guid> as the number 9114821
		// coerceString must call String() on it
		const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
			<title>T</title><link>https://www.bankier.pl</link><description>D</description>
			<item>
				<link>https://www.bankier.pl/wiadomosc/article-9114821.html</link>
				<title>Title</title>
				<description>Desc</description>
				<pubDate>Wed, 16 Apr 2026 10:00:00 +0200</pubDate>
				<guid>9114821</guid>
			</item>
		</channel></rss>`;
		const channel = parseRss(xml);
		expect(channel.items[0].guid).toBe('9114821');
	});

	it('handles element with attributes and text content (#text object from fast-xml-parser)', () => {
		// When an element has attributes, fast-xml-parser returns { "@_attr": "...", "#text": "value" }
		// coerceString must extract the #text field in this case
		const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
			<title type="main">Bankier.pl</title>
			<link>https://www.bankier.pl</link>
			<description>Test</description>
		</channel></rss>`;
		const channel = parseRss(xml);
		expect(channel.title).toBe('Bankier.pl');
	});
});

describe('bankier.ts - fetchRss', () => {
	it('throws when upstream returns non-200', async () => {
		const original = globalThis.fetch;
		globalThis.fetch = async () => new Response('Not Found', { status: 404, statusText: 'Not Found' });
		try {
			await expect(fetchRss('https://example.com/rss.xml')).rejects.toThrow('404');
		} finally {
			globalThis.fetch = original;
		}
	});

	it('parses and returns channel on success', async () => {
		const original = globalThis.fetch;
		globalThis.fetch = async () => new Response(FIXTURE_RSS, { status: 200 });
		try {
			const channel = await fetchRss('https://example.com/rss.xml');
			expect(channel.items.length).toBeGreaterThan(0);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe('bankier.ts - fetchArticleText', () => {
	it('returns statusCode 404 without throwing', async () => {
		const original = globalThis.fetch;
		globalThis.fetch = async () => new Response('', { status: 404 });
		try {
			const result = await fetchArticleText('https://example.com/article-123.html');
			expect(result.statusCode).toBe(404);
			expect(result.text).toBe('');
		} finally {
			globalThis.fetch = original;
		}
	});

	it('returns statusCode 410 without throwing', async () => {
		const original = globalThis.fetch;
		globalThis.fetch = async () => new Response('', { status: 410 });
		try {
			const result = await fetchArticleText('https://example.com/article-123.html');
			expect(result.statusCode).toBe(410);
		} finally {
			globalThis.fetch = original;
		}
	});

	it('extracts text from article HTML via Readability', async () => {
		const original = globalThis.fetch;
		globalThis.fetch = async () => new Response(SAMPLE_ARTICLE_HTML, { status: 200 });
		try {
			const result = await fetchArticleText('https://example.com/article-9114821.html');
			expect(result.statusCode).toBe(200);
			expect(result.text).toContain('Pierwsze zdanie artykułu');
		} finally {
			globalThis.fetch = original;
		}
	});

	it('returns empty string when Readability cannot extract content', async () => {
		// bankier.ts:98 — article?.textContent?.trim() ?? '' fallback
		const original = globalThis.fetch;
		globalThis.fetch = async () => new Response('<html></html>', { status: 200 });
		try {
			const result = await fetchArticleText('https://example.com/article-9114821.html');
			expect(result.statusCode).toBe(200);
			expect(result.text).toBe('');
		} finally {
			globalThis.fetch = original;
		}
	});
});

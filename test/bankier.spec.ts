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

describe('bankier.ts — parseRss', () => {
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
		// first item description has &lt;p&gt;&lt;img ... — should come back as HTML tags
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
});

describe('bankier.ts — fetchRss', () => {
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

describe('bankier.ts — fetchArticleText', () => {
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
});

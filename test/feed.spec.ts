import { describe, it, expect } from 'vitest';
import { buildFeedXml } from '../src/feed';
import type { RssChannel } from '../src/bankier';
import type { ArticleRecord } from '../src/types';

const CHANNEL: RssChannel = {
	title: 'Bankier.pl',
	link: 'https://www.bankier.pl',
	description: 'Wiadomości',
	items: [
		{
			id: '9114821',
			url: 'https://www.bankier.pl/wiadomosc/article-9114821.html',
			title: 'Gdzie najtrudniej o pracę? Te województwa odnotowały największy odpływ ogłoszeń',
			description:
				'<p><img width="945" height="560" src="http://galeria.bankier.pl/img.jpg" alt="" />Od kwietnia 2025 r. systematycznie maleje liczba ofert pracy.</p>',
			pubDate: 'Wed, 16 Apr 2026 10:00:00 +0200',
			guid: 'https://www.bankier.pl/wiadomosc/article-9114821.html',
		},
		{
			id: '9113525',
			url: 'https://www.bankier.pl/wiadomosc/article-9113525.html',
			title: 'Nest Bank stawia na lokaty walutowe. Do 2,25% na depozycie w euro',
			description: 'Nest Bank wprowadza nowe lokaty z oprocentowaniem do 2,25%.',
			pubDate: 'Wed, 16 Apr 2026 09:00:00 +0200',
			guid: 'https://www.bankier.pl/wiadomosc/article-9113525.html',
		},
	],
};

function makeRecord(overrides: Partial<ArticleRecord>): ArticleRecord {
	return {
		id: '9114821',
		url: 'https://www.bankier.pl/wiadomosc/article-9114821.html',
		fetchedAt: '2026-04-16T10:00:00.000Z',
		articleTextHash: null,
		originalTitle: 'Gdzie najtrudniej o pracę? Te województwa odnotowały największy odpływ ogłoszeń',
		originalDescription:
			'<p><img width="945" height="560" src="http://galeria.bankier.pl/img.jpg" alt="" />Od kwietnia 2025 r. systematycznie maleje liczba ofert pracy.</p>',
		refinedTitle: null,
		refinedDescription: null,
		status: 'pending_classification',
		retryCount: 0,
		...overrides,
	};
}

function parseDescriptionFor(xml: string, itemIndex = 0): string {
	const matches = [...xml.matchAll(/<description>([\s\S]*?)<\/description>/g)];
	// index 0 is the channel description; items start at 1
	const raw = matches[itemIndex + 1]?.[1] ?? '';
	// unescape XML entities to get back the HTML string
	return raw
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

function parseTitleFor(xml: string, itemIndex = 0): string {
	const matches = [...xml.matchAll(/<title>([\s\S]*?)<\/title>/g)];
	// index 0 is channel title
	const raw = matches[itemIndex + 1]?.[1] ?? '';
	return raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

describe('feed.ts — buildFeedXml', () => {
	describe('article with no KV record', () => {
		it('uses original title and description', () => {
			const xml = buildFeedXml(CHANNEL, new Map());
			expect(parseTitleFor(xml, 0)).toBe(CHANNEL.items[0].title);
			expect(parseDescriptionFor(xml, 0)).toBe(CHANNEL.items[0].description);
		});
	});

	describe('refined article', () => {
		const record = makeRecord({
			status: 'refined',
			refinedTitle: 'Oferty pracy maleją od roku. Największy spadek w woj. pomorskim',
			refinedDescription:
				'<p><img width="945" height="560" src="http://galeria.bankier.pl/img.jpg" alt="" />Od kwietnia 2025 r. liczba ofert spada.</p>',
		});
		const records = new Map([['9114821', record]]);

		it('uses refinedTitle', () => {
			const xml = buildFeedXml(CHANNEL, records);
			expect(parseTitleFor(xml, 0)).toBe(record.refinedTitle);
		});

		it('starts with refinedDescription', () => {
			const xml = buildFeedXml(CHANNEL, records);
			const desc = parseDescriptionFor(xml, 0);
			expect(desc).toContain(record.refinedDescription!);
		});

		it('appends <hr/> separator', () => {
			const xml = buildFeedXml(CHANNEL, records);
			expect(parseDescriptionFor(xml, 0)).toContain('<hr/>');
		});

		it('appends original title label', () => {
			const xml = buildFeedXml(CHANNEL, records);
			expect(parseDescriptionFor(xml, 0)).toContain(
				`<p>Original title: ${record.originalTitle}</p>`,
			);
		});

		it('appends original description text after <hr/>', () => {
			const xml = buildFeedXml(CHANNEL, records);
			const desc = parseDescriptionFor(xml, 0);
			expect(desc).toContain('Od kwietnia 2025 r. systematycznie maleje liczba ofert pracy.');
		});

		it('strips <img> from appended original description', () => {
			const xml = buildFeedXml(CHANNEL, records);
			const desc = parseDescriptionFor(xml, 0);
			const afterHr = desc.split('<hr/>')[1];
			expect(afterHr).not.toMatch(/<img/);
		});

		it('retains <img> in the refined (top) section', () => {
			const xml = buildFeedXml(CHANNEL, records);
			const desc = parseDescriptionFor(xml, 0);
			const beforeHr = desc.split('<hr/>')[0];
			expect(beforeHr).toContain('<img');
		});
	});

	describe('llm_kept_original article', () => {
		const record = makeRecord({ status: 'llm_kept_original' });
		const records = new Map([['9114821', record]]);

		it('uses original title', () => {
			const xml = buildFeedXml(CHANNEL, records);
			expect(parseTitleFor(xml, 0)).toBe(record.originalTitle);
		});

		it('does not append <hr/> block', () => {
			const xml = buildFeedXml(CHANNEL, records);
			expect(parseDescriptionFor(xml, 0)).not.toContain('<hr/>');
		});
	});

	describe('not_clickbait article', () => {
		const record = makeRecord({ status: 'not_clickbait' });
		const records = new Map([['9114821', record]]);

		it('uses original title and description unchanged', () => {
			const xml = buildFeedXml(CHANNEL, records);
			expect(parseTitleFor(xml, 0)).toBe(record.originalTitle);
			expect(parseDescriptionFor(xml, 0)).toBe(record.originalDescription);
		});

		it('does not append <hr/> block', () => {
			const xml = buildFeedXml(CHANNEL, records);
			expect(parseDescriptionFor(xml, 0)).not.toContain('<hr/>');
		});
	});

	describe('XML escaping', () => {
		const specialChannel: RssChannel = {
			...CHANNEL,
			items: [
				{
					id: '9999999',
					url: 'https://www.bankier.pl/wiadomosc/article-9999999.html',
					title: 'Title with <tags> & "quotes"',
					description: 'Description with <b>bold</b> & ampersand',
					pubDate: 'Wed, 16 Apr 2026 07:00:00 +0200',
					guid: 'https://www.bankier.pl/wiadomosc/article-9999999.html',
				},
			],
		};

		it('escapes special chars in title', () => {
			const xml = buildFeedXml(specialChannel, new Map());
			expect(xml).toContain('Title with &lt;tags&gt; &amp; &quot;quotes&quot;');
		});

		it('escapes special chars in description', () => {
			const xml = buildFeedXml(specialChannel, new Map());
			expect(xml).toContain('Description with &lt;b&gt;bold&lt;/b&gt; &amp; ampersand');
		});
	});

	describe('multiple items', () => {
		it('non-refined second item passes through unchanged', () => {
			const records = new Map([
				['9114821', makeRecord({ status: 'refined', refinedTitle: 'Refined', refinedDescription: '<p>Refined desc</p>' })],
			]);
			const xml = buildFeedXml(CHANNEL, records);
			expect(parseTitleFor(xml, 1)).toBe(CHANNEL.items[1].title);
			expect(parseDescriptionFor(xml, 1)).toBe(CHANNEL.items[1].description);
		});
	});
});

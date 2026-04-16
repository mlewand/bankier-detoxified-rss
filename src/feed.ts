import type { ArticleRecord } from './types';
import type { RssChannel, RssItem } from './bankier';

function escapeXml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function stripImgTags(html: string): string {
	// Intentionally simplified image tag strip. The format is well known.
	// No need to use a full HTML parser for this.
	return html.replace(/<img[^>]*\/?>/gi, '');
}

function renderItem(item: RssItem, record: ArticleRecord | undefined): string {
	const title = record?.refinedTitle ?? item.title;
	let description = record?.refinedDescription ?? item.description;

	if (record?.status === 'refined') {
		description +=
			`<hr/><p>Original title: ${record.originalTitle}</p>` +
			stripImgTags(record.originalDescription);
	}

	return [
		'    <item>',
		`      <title>${escapeXml(title)}</title>`,
		`      <link>${escapeXml(item.url)}</link>`,
		`      <description>${escapeXml(description)}</description>`,
		`      <pubDate>${escapeXml(item.pubDate)}</pubDate>`,
		`      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>`,
		'    </item>',
	].join('\n');
}

export function buildFeedXml(channel: RssChannel, records: Map<string, ArticleRecord>): string {
	const itemsXml = channel.items.map((item) => renderItem(item, records.get(item.id))).join('\n');

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0">',
		'  <channel>',
		`    <title>${escapeXml(channel.title)}</title>`,
		`    <link>${escapeXml(channel.link)}</link>`,
		`    <description>${escapeXml(channel.description)}</description>`,
		itemsXml,
		'  </channel>',
		'</rss>',
	].join('\n');
}

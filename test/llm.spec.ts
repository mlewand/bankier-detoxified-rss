import { describe, it, expect } from 'vitest';
import { extractJson, classifyBatch, refineArticle } from '../src/llm';

// ─── extractJson ──────────────────────────────────────────────────────────────

describe('llm.ts - extractJson', () => {
	it('returns a bare JSON array unchanged', () => {
		const input = '[{"id":"1","clickbait":true}]';
		expect(extractJson(input)).toBe(input);
	});

	it('returns a bare JSON object unchanged', () => {
		const input = '{"title":"foo","description":"bar"}';
		expect(extractJson(input)).toBe(input);
	});

	it('strips ```json code fences', () => {
		const input = '```json\n[{"id":"1","clickbait":false}]\n```';
		expect(extractJson(input)).toBe('[{"id":"1","clickbait":false}]');
	});

	it('strips plain ``` code fences', () => {
		const input = '```\n{"keep_original":true}\n```';
		expect(extractJson(input)).toBe('{"keep_original":true}');
	});

	it('extracts JSON array embedded in prose', () => {
		const input = 'Here is the result:\n[{"id":"2","clickbait":true}]\nDone.';
		expect(extractJson(input)).toBe('[{"id":"2","clickbait":true}]');
	});

	it('extracts JSON object embedded in prose', () => {
		const input = 'Sure! {"title":"New title","description":"New desc"} That is all.';
		expect(extractJson(input)).toBe('{"title":"New title","description":"New desc"}');
	});

	it('prefers array over object when array appears first', () => {
		const input = '[{"id":"1"}] and {"other":true}';
		expect(extractJson(input)).toBe('[{"id":"1"}]');
	});

	it('falls back to trimmed input when no JSON found', () => {
		const input = '  Sorry, I cannot help with that.  ';
		expect(extractJson(input)).toBe('Sorry, I cannot help with that.');
	});

	it('falls back when array bracket found but no closing bracket', () => {
		// [ present but no ] — falls through to object check, then to fallback
		const input = 'starts with [ but never closes';
		expect(extractJson(input)).toBe('starts with [ but never closes');
	});

	it('falls back when object brace found but no closing brace', () => {
		// { present but no } — falls through to fallback
		const input = 'starts with { but never closes';
		expect(extractJson(input)).toBe('starts with { but never closes');
	});
});

// ─── classifyBatch ────────────────────────────────────────────────────────────

const ARTICLES = [
	{ id: '1', title: 'Clickbait title?', description: 'desc1' },
	{ id: '2', title: 'Normal title', description: 'desc2' },
];

function mockFetch(body: unknown, status = 200) {
	const original = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				choices: [{ message: { content: JSON.stringify(body) } }],
			}),
			{ status },
		);
	return () => { globalThis.fetch = original; };
}

describe('llm.ts - classifyBatch', () => {
	it('returns empty array when given no articles', async () => {
		const result = await classifyBatch('key', []);
		expect(result).toEqual([]);
	});

	it('parses valid LLM classification response', async () => {
		const restore = mockFetch([
			{ id: '1', clickbait: true },
			{ id: '2', clickbait: false },
		]);
		try {
			const result = await classifyBatch('key', ARTICLES);
			expect(result).toEqual([
				{ id: '1', clickbait: true },
				{ id: '2', clickbait: false },
			]);
		} finally {
			restore();
		}
	});

	it('drops entries with invalid shape', async () => {
		const restore = mockFetch([
			{ id: '1', clickbait: true },
			{ id: 2, clickbait: 'yes' }, // invalid: id not string, clickbait not boolean
		]);
		try {
			const result = await classifyBatch('key', ARTICLES);
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe('1');
		} finally {
			restore();
		}
	});

	it('throws on non-200 LLM response', async () => {
		const restore = mockFetch({ error: 'unauthorized' }, 401);
		try {
			await expect(classifyBatch('badkey', ARTICLES)).rejects.toThrow('401');
		} finally {
			restore();
		}
	});

	it('returns empty string content when LLM response has no choices', async () => {
		// callLlm returns '' when choices is empty; classifyBatch then fails JSON.parse
		const original = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ choices: [] }), { status: 200 });
		try {
			await expect(classifyBatch('key', ARTICLES)).rejects.toThrow();
		} finally {
			globalThis.fetch = original;
		}
	});
});

// ─── refineArticle ────────────────────────────────────────────────────────────

const ARTICLE_INPUT = {
	title: 'Clickbait?',
	description: 'desc',
	text: 'Full article text.',
};

describe('llm.ts - refineArticle', () => {
	it('returns refined title and description', async () => {
		const restore = mockFetch({ title: 'Clear title', description: 'Clear description' });
		try {
			const result = await refineArticle('key', ARTICLE_INPUT);
			expect(result).toEqual({ title: 'Clear title', description: 'Clear description' });
		} finally {
			restore();
		}
	});

	it('returns keep_original when LLM decides no change needed', async () => {
		const restore = mockFetch({ keep_original: true });
		try {
			const result = await refineArticle('key', ARTICLE_INPUT);
			expect(result).toEqual({ keep_original: true });
		} finally {
			restore();
		}
	});

	it('handles LLM response wrapped in code fences', async () => {
		const original = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					choices: [{ message: { content: '```json\n{"title":"T","description":"D"}\n```' } }],
				}),
				{ status: 200 },
			);
		try {
			const result = await refineArticle('key', ARTICLE_INPUT);
			expect(result).toEqual({ title: 'T', description: 'D' });
		} finally {
			globalThis.fetch = original;
		}
	});

	it('throws on non-200 LLM response', async () => {
		const restore = mockFetch({ error: 'rate_limit' }, 429);
		try {
			await expect(refineArticle('key', ARTICLE_INPUT)).rejects.toThrow('429');
		} finally {
			restore();
		}
	});

	it('truncates article text longer than 8000 chars', async () => {
		const longText = 'x'.repeat(9000);
		let capturedBody = '';
		const original = globalThis.fetch;
		globalThis.fetch = async (url, init) => {
			capturedBody = JSON.parse((init?.body as string) ?? '{}').messages?.[1]?.content ?? '';
			return new Response(
				JSON.stringify({ choices: [{ message: { content: '{"title":"T","description":"D"}' } }] }),
				{ status: 200 },
			);
		};
		try {
			await refineArticle('key', { title: 'T', description: 'D', text: longText });
			expect(capturedBody).toContain('x'.repeat(8000) + '…');
			expect(capturedBody).not.toContain('x'.repeat(8001));
		} finally {
			globalThis.fetch = original;
		}
	});
});

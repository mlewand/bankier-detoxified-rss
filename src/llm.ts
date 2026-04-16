// MiniMax global API (international endpoint, not Chinese region)
const LLM_API_URL = 'https://api.minimax.io/v1/chat/completions';
const LLM_MODEL = 'MiniMax-M2.7';

// ─── Prompts ──────────────────────────────────────────────────────────────────

const CLASSIFICATION_SYSTEM_PROMPT = `You are a news editor analyzing RSS headlines from a Polish financial news site (bankier.pl).
Identify "clickbait" headlines — ones that withhold a key piece of information to force the reader to click.

The KEY signal is WITHHELD INFORMATION: a headline is clickbait when it refers to a specific fact (a number, a named entity, a key noun) without revealing it.
The two-clause "X. Y" structure is NOT itself a red flag — many legitimate headlines use it too.

Return ONLY a valid JSON array, no prose. Format: [{"id":"...","clickbait":true},...]

CLICKBAIT examples:
- id:9114718 | "Prawie miliard na reklamy. Sprawdź, który bank wydał najwięcej" → clickbait (withholds which bank and exact amount)
- id:9114901 | "200 zł za kilo czereśni. W tym roku to już nieaktualne" → clickbait (withholds current price)
- id:9113428 | "Blisko 10% inflacji w kraju Unii Europejskiej. Dobrze, że to nie w Polsce" → clickbait (withholds which country)
- id:9108916 | "Strategiczny zasób cenniejszy niż energia. Prezydent Turcji wskazał nowe źródło konfliktów" → clickbait (withholds what resource)
- id:9107318 | "Ten kraj też wdroży konta bez podatku od zysków. I też wzoruje się na Szwecji" → clickbait (withholds which country)
- id:9106370 | "System kaucyjny: taki zwrot zgarnął nowy rekordzista" → clickbait (withholds refund amount)

NOT CLICKBAIT examples:
- id:9114780 | "Eksportowy rajd Pekinu. Chiński smok odporny na blokadę Cieśniny Ormuz" → not clickbait (both clauses informative)
- id:9113525 | "Nest Bank stawia na lokaty walutowe. Do 2,25% na depozycie w euro" → not clickbait (bank and rate stated)
- id:7961165 | "Austria weszła w drugą falę epidemii koronawirusa" → not clickbait (complete fact)
- id:9114245 | "Prof. Postuła: 6,3 mld zł na obronność i technologie. Budujemy odporność gospodarki" → not clickbait (specific amount present)
- id:9114937 | "Mark Mobius nie żyje. Pożegnanie legendy rynków wschodzących" → not clickbait (factual)`;

const REFINEMENT_SYSTEM_PROMPT = `You are a news editor rewriting clickbait headlines from a Polish financial news site (bankier.pl) into clear, direct headlines.

Given the original title, description, and full article text:
1. Rewrite the title to directly state the withheld key fact. Keep it concise (under 120 characters). Preserve Polish language.
2. Rewrite the description to state the most important facts directly.
   - If the original description uses HTML, return your rewritten text as HTML too.
   - If the original description contains an <img> tag, copy it verbatim to the start of your rewritten description.

If the original title actually contains all key information (no meaningful withholding), return: {"keep_original":true}
Otherwise return: {"title":"...","description":"..."}

Return ONLY valid JSON, no prose, no code fences.`;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ArticleInput {
	id: string;
	title: string;
	description: string;
}

export interface ClassifyResult {
	id: string;
	clickbait: boolean;
}

export type RefineResult =
	| { keep_original: true }
	| { keep_original?: false; title: string; description: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractJson(text: string): string {
	// Strip code fences if present
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();

	// Find first JSON array or object
	const arrayStart = text.indexOf('[');
	const objStart = text.indexOf('{');

	if (arrayStart !== -1 && (objStart === -1 || arrayStart < objStart)) {
		const arrayEnd = text.lastIndexOf(']');
		if (arrayEnd > arrayStart) return text.slice(arrayStart, arrayEnd + 1);
	}
	if (objStart !== -1) {
		const objEnd = text.lastIndexOf('}');
		if (objEnd > objStart) return text.slice(objStart, objEnd + 1);
	}

	return text.trim();
}

async function callLlm(apiKey: string, systemPrompt: string, userContent: string): Promise<string> {
	const resp = await fetch(LLM_API_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: LLM_MODEL,
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userContent },
			],
			temperature: 0.1,
		}),
	});

	if (!resp.ok) {
		const body = await resp.text();
		throw new Error(`LLM API ${resp.status}: ${body.slice(0, 300)}`);
	}

	const data = (await resp.json()) as { choices: { message: { content: string } }[] };
	return data.choices?.[0]?.message?.content ?? '';
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function classifyBatch(apiKey: string, articles: ArticleInput[]): Promise<ClassifyResult[]> {
	if (articles.length === 0) return [];

	const userContent = articles
		.map((a) => `id:${a.id} | title: ${a.title}\ndescription: ${a.description}`)
		.join('\n\n');

	const raw = await callLlm(apiKey, CLASSIFICATION_SYSTEM_PROMPT, userContent);
	const jsonStr = extractJson(raw);
	const parsed = JSON.parse(jsonStr) as unknown[];

	// Validate shape — drop entries that don't match
	return parsed.filter(
		(r): r is ClassifyResult =>
			typeof r === 'object' &&
			r !== null &&
			typeof (r as ClassifyResult).id === 'string' &&
			typeof (r as ClassifyResult).clickbait === 'boolean',
	);
}

export async function refineArticle(
	apiKey: string,
	article: { title: string; description: string; text: string },
): Promise<RefineResult> {
	// Truncate to ~8 000 chars to stay within context budget
	const truncatedText = article.text.length > 8000 ? article.text.slice(0, 8000) + '…' : article.text;

	const userContent =
		`Original title: ${article.title}\n` +
		`Original description: ${article.description}\n\n` +
		`Article text:\n${truncatedText}`;

	const raw = await callLlm(apiKey, REFINEMENT_SYSTEM_PROMPT, userContent);
	const jsonStr = extractJson(raw);
	return JSON.parse(jsonStr) as RefineResult;
}

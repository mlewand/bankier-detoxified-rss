export interface Config {
	llmApiKey: string;
	upstreamRssUrl: string;
}

export function getConfig(env: Env): Config {
	return {
		llmApiKey: env.LLM_API_KEY,
		upstreamRssUrl: env.UPSTREAM_RSS_URL,
	};
}

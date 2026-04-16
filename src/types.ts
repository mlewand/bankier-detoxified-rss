export type ArticleStatus =
	| 'pending_classification'
	| 'not_clickbait'
	| 'llm_kept_original'
	| 'pending_refinement'
	| 'refined'
	| 'error_retryable_classification'
	| 'error_retryable_refinement'
	| 'error_permanent';

export interface ArticleRecord {
	id: string;
	url: string;
	fetchedAt: string; // ISO 8601
	articleTextHash: string | null;
	originalTitle: string;
	originalDescription: string;
	refinedTitle: string | null;
	refinedDescription: string | null;
	status: ArticleStatus;
	retryCount: number;
}

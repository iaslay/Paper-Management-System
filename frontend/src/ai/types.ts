import type { ReadingPreview } from '../api'
export type Origin = 'paper_fact' | 'author_claim' | 'system_inference' | 'user_record'
export interface Evidence { page_source_id: string | null; page_number: number | null; note_id: string | null; excerpt: string; description: string; verification: 'unverified' | 'user_checked' }
export interface Claim { text: string; origin: Origin; evidence: Evidence[] }
export interface Suggestion { tag_id: number | null; name: string; reason: string; evidence: Evidence[] }
export interface CardData { preview?: ReadingPreview | null; schema_version: '1.0'; summary: Claim; research_question: Claim; method: Claim; contributions: Claim[]; findings: Claim[]; limitations: Claim[]; personal_value: string; paper_type: string; research_direction_suggestions: Suggestion[] }
export interface CardVersion { id: string; paper_id: string; file_hash: string; sequence: number; data: CardData; source: 'ai' | 'manual'; confirmed_at: number | null; created_at: number; warnings: string[]; base_version_id: string | null; model_info?: {model:string;provider:string;input_mode:string;config_revision:number;prompt_version:string} | null }
export interface CardState { paper_id: string; card_revision: number; current_version_id: string | null; versions: CardVersion[]; decisions: Record<string, { status: 'accepted' | 'ignored'; tag_id: number | null }>; version_decisions?: Record<string, Record<string, {status:'accepted'|'ignored';tag_id:number|null}>> }
export interface ModelOptions { provider: 'responses' | 'claude' | 'chat'; base_url: string; model: string; enabled: boolean; auto_on_read: boolean; input_mode: 'auto' | 'pdf' | 'images'; structured_output: boolean; batch_pages: number; max_request_bytes: number; image_long_edge: number; max_output_tokens: number; max_calls: number; input_tokens_per_page: number; max_task_tokens: number; monthly_token_limit: number; timeout_seconds: number }
export interface ModelSettings extends ModelOptions { revision: number; has_key: boolean; tested_mode: 'pdf' | 'images' | null; tested_at: number | null; test_error: string | null }
export interface ModelCall { id: string; stage: string; status: string; input_tokens: number | null; output_tokens: number | null; estimated_tokens: number; pages: number[]; created_at: number }
export interface Usage { month: string; occupied_tokens: number; accounted_tokens: number; reserved_tokens: number; unknown_tasks: number; task_count: number; monthly_token_limit: number; connection_test_calls: number; calls: ModelCall[] }
export interface CardTask { id: string; paper_id: string; status: 'queued' | 'running' | 'waiting_retry' | 'succeeded' | 'failed' | 'cancelled'; stage: string; progress: number; error_message: string | null; error_code: string | null; result_version_id: string | null; charged_tokens: number; reserved_tokens: number; usage_unknown: boolean; created_at: number }
export const originNames: Record<Origin, string> = { paper_fact: '原文事实', author_claim: '作者主张', system_inference: '系统推测', user_record: '用户记录／修改' }
export const typeNames: Record<string, string> = { empirical: '实证研究', theoretical: '理论研究', survey: '综述', other: '其他', unknown: '未确定' }
export const stageNames: Record<string, string> = { queued: '排队中', preparing: '准备原文输入', analyzing: '视觉理解', summarizing: '汇总各页段', repairing: '修复输出格式', validating: '核对来源', succeeded: '草稿已生成', failed: '生成未完成', cancelled: '已取消' }
export function emptyCard(): CardData {
  const claim = (): Claim => ({ text: '', origin: 'user_record', evidence: [] })
  return { schema_version: '1.0', summary: claim(), research_question: claim(), method: claim(), contributions: [], findings: [], limitations: [], personal_value: '', paper_type: 'unknown', research_direction_suggestions: [] }
}
export function normalizeDirection(value: string) { return value.normalize('NFKC').trim().toLocaleLowerCase() }
export function modelOptions(settings: ModelSettings): ModelOptions {
  const { revision, has_key, tested_mode, tested_at, test_error, ...options } = settings
  return options
}

export type Provider = 'arxiv' | 'acl' | 'ieee'
export interface LiteratureRecord {
  provider: Provider | 'citation'; source_id: string; title: string; authors: string[]; abstract: string;
  year: number | null; doi: string | null; url: string; pdf_url: string | null;
  published: string; updated: string; version: string; venue: string; volume_id: string; category: string;
  access: string; source_revision: string; date_precision: string;
  candidate_id?: string | null; saved?: boolean; paper_id?: string | null; in_trash?: boolean;
}
export interface Candidate { id: string; record: LiteratureRecord; direction_ids: number[]; paper_id: string | null; in_trash: boolean; saved: boolean }
export interface ImportTask { id: string; title: string; candidate_id: string; status: string; phase: string; attempt: number; error: string; paper_id: string | null; downloaded_bytes: number }
export interface IEEEConfiguration { configured: boolean; revision: number; test_status: string; tested_at: number | null; error: string; daily_limit: number; calls_today: number; counter_day: string }
export interface ACLStatus { ready: boolean; generation?: string; source_revision?: string; records?: number; updated_at?: number; checked_at?: number; venues: string[]; task: { id: string; status: string; phase: string; processed: number; error: string } | null }
export interface Providers { arxiv: { ready: boolean }; ieee: IEEEConfiguration; acl: ACLStatus }
export interface SearchResults { items: LiteratureRecord[]; total: number; provider: Provider; data_time: number; next_cursor: string | null; page: number; cached?: boolean; index_generation?: string }
export const providerNames = { arxiv: 'arXiv', acl: 'ACL Anthology', ieee: 'IEEE Xplore', citation: '导入引文' }
export const taskNames: Record<string, string> = { queued: '排队中', running: '导入中', retrying: '等待重试', succeeded: '已入库', failed: '未完成', cancelled: '已取消' }
export const phaseNames: Record<string, string> = { queued: '等待处理', source: '核对来源', download: '下载原文', retry_wait: '稍后重试下载', inspect: '检查 PDF', registered: '已登记', fetch: '获取官方元数据', index: '建立论文索引', ready: '已就绪' }
export const requestId = () => crypto.randomUUID().replaceAll('-', '')
export const timeText = (value?: number | null) => value ? new Date(value * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚未更新'

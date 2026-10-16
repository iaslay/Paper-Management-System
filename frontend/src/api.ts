export interface User { username: string; workspace_name: string; quota_bytes: number }
export type ReadingStatus = 'unread' | 'reading' | 'read'
export type Kind = 'research_direction' | 'general' | 'topic'
export interface Label { id: number; name: string }
export interface ReadingPreview { headline: string; problem: string; approach: string; benefit: string }
export interface Tag extends Label { kind: Kind; aliases: string[]; revision: number; paper_count: number; deleted_at: number | null; merged_into_id: number | null }
export interface Paper {
  id: string; title: string; authors: string[]; year: number | null; doi: string | null;
  original_filename: string; file_size: number; page_count: number; reading_status: ReadingStatus;
  file_hash: string; last_read_page: number | null; last_opened_at: number | null;
  is_favorite: boolean; revision: number; created_at: number; updated_at: number; deleted_at: number | null;
  research_directions: Label[]; tags: Label[]; topics: Label[];
  card_summary: string | null; card_status: 'draft' | 'confirmed' | null;
  card_preview?: (ReadingPreview & {version_id: string}) | null;
  card_brief?: Pick<ReadingPreview, 'problem' | 'approach' | 'benefit'> | null;
  card_generation_notice?: {task_id?: string; message: string};
}
export interface Library {
  items: Paper[]; total: number; page: number; page_size: number;
  stats: { total: number; unread: number; reading: number; read: number; favorite: number; trash: number; used_bytes: number };
  direction_counts: Record<string, number>;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public current?: unknown) { super(message) }
}

function expired(status: number) {
  if (status === 401) window.dispatchEvent(new Event('paperboard-auth-expired'))
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api/v1' + path, {
    credentials: 'same-origin', ...options,
    headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), 'X-Paperboard-Request': '1', ...options.headers },
  }).catch(cause => { if (cause?.name === 'AbortError') throw cause; throw new Error('连接中断，请检查本机服务后重试。') })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (path !== '/session') expired(response.status)
    throw new ApiError(typeof data.detail === 'string' ? data.detail : '操作未完成，请稍后重试。', response.status, data.code, data.current)
  }
  return data as T
}

export async function readingApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try { return await api<T>(path, { ...options, signal: controller.signal }) }
  catch (cause) {
    if ((cause as Error).name === 'AbortError') throw new Error('保存响应超时，内容仍保留在当前页面，可以安全重试。')
    throw cause
  } finally { clearTimeout(timer) }
}

export function uploadPdf(file: File, directions: number[], onProgress: (percentage: number) => void, signal: AbortSignal): Promise<{ paper: Paper; duplicate: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    signal.addEventListener('abort', abort, { once: true })
    xhr.open('POST', '/api/v1/papers')
    xhr.setRequestHeader('X-Paperboard-Request', '1')
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)) }
    xhr.onload = () => {
      signal.removeEventListener('abort', abort)
      let data: { detail?: string; paper: Paper; duplicate: boolean }
      try { data = JSON.parse(xhr.responseText) } catch { reject(new Error('服务器返回异常，请重试。')); return }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data)
      else { expired(xhr.status); reject(new ApiError(data.detail || '上传失败，请重试。', xhr.status)) }
    }
    xhr.onerror = () => { signal.removeEventListener('abort', abort); reject(new Error('网络连接中断，请重试。')) }
    xhr.onabort = () => { signal.removeEventListener('abort', abort); reject(new Error('已取消上传；如果文件已保存，可以在论文库查看。')) }
    const form = new FormData()
    form.append('file', file)
    form.append('direction_ids', JSON.stringify(directions))
    if (signal.aborted) { reject(new Error('已取消上传')); return }
    xhr.send(form)
  })
}

export const statusNames: Record<ReadingStatus, string> = { unread: '待读', reading: '阅读中', read: '已读' }
export const kindNames: Record<Kind, string> = { research_direction: '研究方向', general: '普通标签', topic: '主题' }
export function sizeText(bytes: number) { return bytes <= 0 ? '0 KB' : bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(1) + ' GB' : bytes >= 1024 ** 2 ? (bytes / 1024 ** 2).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB' }
export function dateText(value: number) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(new Date(value * 1000)) }

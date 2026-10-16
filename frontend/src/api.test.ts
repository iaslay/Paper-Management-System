import { afterEach, expect, it, vi } from 'vitest'
import { api, readingApi, ApiError } from './api'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
it('PDF 补传交给浏览器生成分段表单边界，仍带同源请求标识', async () => {
  const send = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', send)
  const body = new FormData(); body.append('candidate_id', 'candidate')
  await api('/papers', { method: 'POST', body })
  expect(send.mock.calls[0][1].headers['Content-Type']).toBeUndefined()
  expect(send.mock.calls[0][1].headers['X-Paperboard-Request']).toBe('1')
  expect(send.mock.calls[0][1].body).toBe(body)
})
it('网络失败显示中文并保留调用方草稿恢复路径', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
  await expect(readingApi('/notes/test')).rejects.toThrow('连接中断，请检查本机服务后重试。')
})
it('冲突响应保留业务错误码和服务器版本', async () => {
  const current = { revision: 5, content: '服务器内容' }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: '版本冲突', code: 'revision_conflict', current }), { status: 409 })))
  const request = api('/notes/test')
  await expect(request).rejects.toBeInstanceOf(ApiError)
  await expect(request).rejects.toMatchObject({ status: 409, code: 'revision_conflict', current })
})
it('保存超时终止本地等待但明确提示可以安全重试', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn((_, options) => new Promise((_, reject) => { options.signal.addEventListener('abort', () => reject(new DOMException('请求已停止', 'AbortError'))) })))
  const assertion = expect(readingApi('/notes/test')).rejects.toThrow('保存响应超时')
  await vi.advanceTimersByTimeAsync(15000); await assertion
})

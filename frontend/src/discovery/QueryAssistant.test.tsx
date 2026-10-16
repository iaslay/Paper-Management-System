import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import QueryAssistant from './QueryAssistant'
import DiscoveryPage from './DiscoveryPage'
import { api, ApiError } from '../api'

vi.mock('../api', async () => ({ ...await vi.importActual('../api'), api: vi.fn() }))
const suggestions = {
  intent: '查找对话中的长期记忆更新方法', keywords: [{ concept: '长期记忆', terms: ['long term memory', 'memory update'] }],
  queries: [{ label: '主题聚焦', q: '"long term memory" dialogue', reason: '聚焦对话中的记忆。' }, { label: '拓展方法', q: '"memory update" agents', reason: '查找更新方法。' }],
  notes: null, year_filter: { year_from: 2024, year_to: 2026, evidence: '近三年（按含今年的自然年计算）' },
}
const completed = { id: 'query-task', request_id: 'request', provider: 'acl', text: '想找近三年的长期记忆论文', status: 'succeeded', result: suggestions, model: 'deepseek-flash', input_tokens: 100, output_tokens: 200, usage_unknown: false, error: '' }
let recent: any[], model: { enabled: boolean; model: string }, create: any
beforeEach(() => {
  vi.clearAllMocks(); recent = []; model = { enabled: true, model: 'deepseek-flash' }
  create = async () => completed
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/discovery/query-assists/status') return { ...model }
    if (path.startsWith('/discovery/query-assists?')) return recent
    if (path === '/discovery/query-assists' && options?.method === 'POST') return create(path, options)
    if (path.endsWith('/cancel')) return { ...completed, status: 'cancelled', result: null }
    if (path.startsWith('/discovery/query-assists/')) return completed
    if (path === '/discovery/providers') return { arxiv: { ready: true }, acl: { ready: true, venues: [], task: null }, ieee: { configured: false } }
    if (path === '/discovery/candidates' || path === '/paper-imports') return []
    if (path === '/settings/institution-access') return { portal_url: 'https://vpn.uestc.edu.cn/' }
    return { items: [], total: 0, next_cursor: null, data_time: 1 }
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
function view(extra = {}) { return <QueryAssistant active provider="acl" onApply={vi.fn()} onSettings={vi.fn()} {...extra} /> }
async function opened(extra = {}) { const result = render(view(extra)); await result.findByText('deepseek-flash'); return result }
const posts = () => vi.mocked(api).mock.calls.filter(([path, options]) => path === '/discovery/query-assists' && options?.method === 'POST')

it('打开、输入和折叠不调用模型，明确生成才发送当前问题和来源', async () => {
  const result = await opened()
  fireEvent.change(result.getByLabelText('ACL Anthology 研究问题'), { target: { value: '想找近三年的长期记忆论文' } })
  expect(posts()).toHaveLength(0)
  fireEvent.click(result.getByRole('button', { name: '生成检索建议' }))
  await result.findByRole('region', { name: 'AI 检索建议' })
  expect(JSON.parse(posts()[0][1]?.body as string)).toMatchObject({ text: '想找近三年的长期记忆论文', provider: 'acl' })
  expect(vi.mocked(api).mock.calls.some(([path]) => path.startsWith('/discovery/search?'))).toBe(false)
})
it('备选表达可编辑，填入前不修改检索，年份需单独选择', async () => {
  recent = [completed]
  const apply = vi.fn(), result = render(view({ onApply: apply }))
  await result.findByRole('region', { name: 'AI 检索建议' })
  expect(apply).not.toHaveBeenCalled()
  fireEvent.click(result.getByRole('button', { name: '拓展方法' }))
  expect((result.getByLabelText('ACL Anthology 建议关键词') as HTMLInputElement).value).toBe('"memory update" agents')
  fireEvent.change(result.getByLabelText('ACL Anthology 建议关键词'), { target: { value: 'memory evolution dialogue' } })
  fireEvent.click(result.getByRole('button', { name: '填入检索框' }))
  expect(apply).toHaveBeenLastCalledWith({ q: 'memory evolution dialogue', years: undefined })
  fireEvent.click(result.getByRole('checkbox', { name: /同时应用年份建议/ }))
  fireEvent.click(result.getByRole('button', { name: '填入检索框' }))
  expect(apply).toHaveBeenLastCalledWith({ q: 'memory evolution dialogue', years: suggestions.year_filter })
})
it('生成中输入新问题不会被迟到结果覆盖', async () => {
  let finish: any
  create = () => new Promise(resolve => { finish = resolve })
  const result = await opened()
  fireEvent.change(result.getByLabelText('ACL Anthology 研究问题'), { target: { value: '第一个研究问题' } })
  fireEvent.click(result.getByRole('button', { name: '生成检索建议' }))
  fireEvent.change(result.getByLabelText('ACL Anthology 研究问题'), { target: { value: '后来补充的新研究问题' } })
  await act(async () => finish(completed))
  expect((result.getByLabelText('ACL Anthology 研究问题') as HTMLTextAreaElement).value).toBe('后来补充的新研究问题')
  expect(result.getByText('依据的问题：' + completed.text)).toBeTruthy()
})
it('响应不确定时安全重试同一提交，不把后来编辑的问题重复发送', async () => {
  create = vi.fn().mockRejectedValueOnce(new Error('连接中断')).mockResolvedValueOnce(completed)
  const result = await opened()
  fireEvent.change(result.getByLabelText('ACL Anthology 研究问题'), { target: { value: '原研究问题' } })
  fireEvent.click(result.getByRole('button', { name: '生成检索建议' })); await result.findByRole('alert')
  const original = posts()[0][1]?.body
  fireEvent.change(result.getByLabelText('ACL Anthology 研究问题'), { target: { value: '尚未发送的新问题' } })
  fireEvent.click(result.getByRole('button', { name: '安全重试提交' }))
  await result.findByRole('region', { name: 'AI 检索建议' })
  expect(posts()[1][1]?.body).toBe(original)
  expect((result.getByLabelText('ACL Anthology 研究问题') as HTMLTextAreaElement).value).toBe('尚未发送的新问题')
})
it('模型未启用时给出设置入口，模型设置更新后恢复生成入口', async () => {
  model.enabled = false
  const settings = vi.fn(), result = render(view({ onSettings: settings }))
  await result.findByText(/先在模型设置中启用已有 DeepSeek/)
  fireEvent.change(result.getByLabelText('ACL Anthology 研究问题'), { target: { value: '研究问题' } })
  expect(result.getByRole('button', { name: '生成检索建议' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(result.getByRole('button', { name: '模型设置' })); expect(settings).toHaveBeenCalledOnce()
  model.enabled = true
  act(() => window.dispatchEvent(new Event('paperboard-model-changed')))
  await waitFor(() => expect(result.getByRole('button', { name: '生成检索建议' }).hasAttribute('disabled')).toBe(false))
  expect(posts()).toHaveLength(0)
})
it('预算不足的明确失败不提供可能重复扣费的安全重试入口', async () => {
  create = async () => { throw new ApiError('月度模型预算不足', 409, 'monthly_budget_exceeded') }
  const result = await opened()
  fireEvent.change(result.getByLabelText('ACL Anthology 研究问题'), { target: { value: '研究问题' } })
  fireEvent.click(result.getByRole('button', { name: '生成检索建议' })); await result.findByRole('alert')
  expect(result.queryByRole('button', { name: '安全重试提交' })).toBeNull()
  expect((result.getByLabelText('ACL Anthology 研究问题') as HTMLTextAreaElement).value).toBe('研究问题')
})
it('停止已排队的生成保留问题与旧建议', async () => {
  recent = [{ ...completed, id: 'new-task', status: 'queued', result: null }, completed]
  const result = render(view())
  await result.findByRole('button', { name: '停止生成' })
  fireEvent.click(result.getByRole('button', { name: '停止生成' }))
  await result.findByText(/生成已停止/)
  expect(result.getByRole('region', { name: 'AI 检索建议' })).toBeTruthy()
})
it('模型状态刷新不会重置失败后保留的已编辑建议', async () => {
  recent = [{ ...completed, id: 'failed-task', status: 'failed', result: null, error: '未完成' }, completed]
  const result = render(view())
  await result.findByRole('region', { name: 'AI 检索建议' })
  fireEvent.change(result.getByLabelText('ACL Anthology 建议关键词'), { target: { value: 'edited memory keywords' } })
  act(() => window.dispatchEvent(new Event('paperboard-model-changed')))
  await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/status')).length).toBe(2))
  expect((result.getByLabelText('ACL Anthology 建议关键词') as HTMLInputElement).value).toBe('edited memory keywords')
})
it('来源与候选页切换保留各自自然语言草稿，填入仅作用于当前来源', async () => {
  recent = [completed]
  const result = render(<DiscoveryPage active tags={[]} onOpenPaper={vi.fn()} onChanged={vi.fn()} />)
  await result.findByRole('region', { name: 'AI 检索建议' })
  fireEvent.change(result.getByLabelText('arXiv 研究问题'), { target: { value: '未发送的 arXiv 问题' } })
  fireEvent.change(result.getByLabelText('起始年份'), { target: { value: '2020' } })
  fireEvent.click(result.getByRole('button', { name: '填入检索框' }))
  expect((result.getByLabelText('论文检索词') as HTMLInputElement).value).toBe(suggestions.queries[0].q)
  expect((result.getByLabelText('起始年份') as HTMLInputElement).value).toBe('2020')
  expect(vi.mocked(api).mock.calls.some(([path]) => path.startsWith('/discovery/search?'))).toBe(false)
  fireEvent.click(result.getByRole('button', { name: /ACL Anthology/ }))
  fireEvent.change(result.getByLabelText('ACL Anthology 研究问题'), { target: { value: 'ACL 问题' } })
  fireEvent.click(result.getByRole('button', { name: /待导入/ }))
  fireEvent.click(result.getByRole('button', { name: '检索结果' }))
  fireEvent.click(result.getByRole('button', { name: /arXiv/ }))
  expect((result.getByLabelText('arXiv 研究问题') as HTMLTextAreaElement).value).toBe('未发送的 arXiv 问题')
})

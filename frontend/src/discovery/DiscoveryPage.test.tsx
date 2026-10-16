import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DiscoveryPage from './DiscoveryPage'
import DiscoverySettings from './DiscoverySettings'
import { api } from '../api'

vi.mock('../api', async () => ({ ...await vi.importActual('../api'), api: vi.fn() }))
const config = { configured: false, revision: 0, daily_limit: 200, calls_today: 0, test_status: 'unconfigured' }
const record = { provider: 'arxiv', source_id: '2601.05960v2', title: '论文记忆方法', authors: ['Alice'], abstract: '研究记忆更新。', year: 2026, pdf_url: 'https://arxiv.org/pdf/2601.05960v2', url: 'https://arxiv.org/abs/2601.05960v2' }
let sources: any, saved: any[], searches: any
beforeEach(() => {
  vi.clearAllMocks()
  saved = []; sources = { arxiv: { ready: true }, acl: { ready: false, venues: [], task: null }, ieee: { ...config } }
  searches = async () => ({ items: [record], total: 25, next_cursor: 'next', data_time: 1 })
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/discovery/providers') return sources
    if (path === '/discovery/candidates' && options?.method === 'POST') { const item = { id: 'candidate', record, direction_ids: [], paper_id: null }; saved = [item]; return item }
    if (path === '/discovery/candidates') return saved
    if (path === '/paper-imports') return []
    if (path.startsWith('/settings/institution-access')) return { mode: 'webvpn', portal_url: 'https://vpn.uestc.edu.cn/' }
    if (path === '/settings/discovery-providers') return config
    if (path.startsWith('/discovery/search?')) return searches(path, options)
    return {}
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
async function opened() { const view = render(<DiscoveryPage active tags={[]} onOpenPaper={vi.fn()} onChanged={vi.fn()} />); await waitFor(() => expect(api).toHaveBeenCalledWith('/discovery/providers', expect.anything())); return view }
const networkCalls = () => vi.mocked(api).mock.calls.filter(([path]) => path.startsWith('/discovery/search?'))

it('打开页面和编辑检索词不发外网请求，显式检索后才展示结果', async () => {
  const view = await opened()
  fireEvent.change(view.getByLabelText('论文检索词'), { target: { value: 'memory' } })
  expect(networkCalls()).toHaveLength(0)
  fireEvent.click(view.getByRole('button', { name: '检索论文' }))
  await view.findByRole('button', { name: record.title })
  expect(networkCalls()).toHaveLength(1)
})
it('缺少 IEEE 密钥时提供设置入口，并保留 arXiv 输入', async () => {
  const view = await opened()
  fireEvent.change(view.getByLabelText('论文检索词'), { target: { value: 'memory' } })
  fireEvent.click(view.getByRole('button', { name: /IEEE Xplore/ }))
  await view.findByRole('button', { name: '配置 IEEE 检索' })
  expect((view.getByRole('button', { name: '检索论文' }) as HTMLButtonElement).disabled).toBe(true)
  expect(networkCalls()).toHaveLength(0)
  fireEvent.click(view.getByRole('button', { name: /arXiv/ }))
  expect((view.getByLabelText('论文检索词') as HTMLInputElement).value).toBe('memory')
})
it('修改输入后加载更多仍沿用已提交的条件，避免混入新查询', async () => {
  const view = await opened()
  fireEvent.change(view.getByLabelText('论文检索词'), { target: { value: 'memory' } })
  fireEvent.click(view.getByRole('button', { name: '检索论文' }))
  await view.findByRole('button', { name: record.title })
  fireEvent.change(view.getByLabelText('论文检索词'), { target: { value: 'new query' } })
  fireEvent.change(view.getByLabelText('起始年份'), { target: { value: '2026' } })
  searches = async () => ({ items: [{ ...record, source_id: '2601.05961v1', title: '另一篇论文' }], total: 25, next_cursor: null, data_time: 1 })
  fireEvent.click(view.getByRole('button', { name: '加载更多论文' }))
  await view.findByRole('button', { name: '另一篇论文' })
  const params = new URLSearchParams(networkCalls()[1][0].split('?')[1])
  expect(params.get('q')).toBe('memory'); expect(params.get('year_from')).toBeNull(); expect(params.get('cursor')).toBe('next')
})
it('切换来源后忽略旧请求的迟到结果', async () => {
  let finish: any
  searches = () => new Promise(resolve => { finish = resolve })
  const view = await opened()
  fireEvent.change(view.getByLabelText('论文检索词'), { target: { value: 'memory' } })
  fireEvent.click(view.getByRole('button', { name: '检索论文' }))
  fireEvent.click(view.getByRole('button', { name: /ACL Anthology/ }))
  await act(async () => { finish({ items: [record], total: 1, next_cursor: null, data_time: 1 }) })
  expect(networkCalls()[0][1]?.signal?.aborted).toBe(true)
  expect(view.queryByRole('button', { name: record.title })).toBeNull()
})
it('IEEE 候选先通过机构获取原文，补传前必须核对论文', async () => {
  saved = [{ id: 'ieee-candidate', record: { ...record, provider: 'ieee', pdf_url: null }, direction_ids: [] }]
  const view = await opened()
  fireEvent.click(view.getByRole('button', { name: '待导入 · 1' }))
  fireEvent.click(view.getByRole('button', { name: '通过机构获取全文' }))
  await view.findByRole('dialog', { name: '获取并补传论文原文' })
  expect((view.getByRole('button', { name: '上传此篇 PDF' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(view.getByLabelText('我已核对所传 PDF 与这篇论文对应'))
  expect((view.getByRole('button', { name: '上传此篇 PDF' }) as HTMLButtonElement).disabled).toBe(false)
  expect(view.getAllByRole('link', { name: /打开机构入口/ })[0].getAttribute('href')).toBe('https://vpn.uestc.edu.cn/')
  expect(networkCalls()).toHaveLength(0)
})
it('检索失败保留输入和已有结果，允许重试', async () => {
  const view = await opened()
  fireEvent.change(view.getByLabelText('论文检索词'), { target: { value: 'memory' } })
  fireEvent.click(view.getByRole('button', { name: '检索论文' })); await view.findByRole('button', { name: record.title })
  searches = async () => { throw new Error('来源暂时不可用') }
  fireEvent.click(view.getByRole('button', { name: '检索论文' })); await view.findByRole('alert')
  expect((view.getByLabelText('论文检索词') as HTMLInputElement).value).toBe('memory')
  expect(view.getByRole('button', { name: record.title })).toBeTruthy()
})
it('未保存密钥的底部关闭按钮遵守离开保护，测试不发送未保存密钥', async () => {
  const close = vi.fn(); vi.spyOn(window, 'confirm').mockReturnValue(false)
  const view = render(<DiscoverySettings onClose={close} onSaved={vi.fn()} />)
  await waitFor(() => expect((view.getByRole('button', { name: '保存检索设置' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.change(view.getByLabelText('IEEE API 密钥'), { target: { value: 'unsaved-private-key' } })
  fireEvent.click(view.getByRole('button', { name: '关闭' }))
  expect(window.confirm).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled()
  expect((view.getByRole('button', { name: '测试 IEEE 检索' }) as HTMLButtonElement).disabled).toBe(true)
  expect(vi.mocked(api).mock.calls.some(([path, opts]) => path.endsWith('/test') || (opts?.body || '').toString().includes('unsaved-private-key'))).toBe(false)
})

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PaperLibraryCard from './PaperLibraryCard'
import { api, readingApi, type Paper } from './api'

vi.mock('./api', async () => ({...await vi.importActual('./api'), api: vi.fn(), readingApi: vi.fn()}))
const paper: Paper = {id:'a'.repeat(32), title:'Long original academic title', authors:['作者一','作者二','作者三'], year:2026, doi:null, original_filename:'paper.pdf', file_size:1000, page_count:18, reading_status:'read', file_hash:'f'.repeat(64), last_read_page:2, last_opened_at:1, is_favorite:false, revision:1, created_at:1, updated_at:1, deleted_at:null, research_directions:[{id:1,name:'个性化生成'}], topics:[], tags:[], card_summary:'原有技术摘要', card_status:'confirmed', card_preview:{version_id:'b'.repeat(32), headline:'让对话系统持续记住用户', problem:'长对话容易遗忘用户信息。', approach:'分层保存并随对话更新。', benefit:'提升个性化回答的一致性。'}}
const props = () => ({checked:false,pending:false,enabled:true,trash:false,onSelect:vi.fn(),onOpen:vi.fn(),onInfo:vi.fn(),onCard:vi.fn(),onFavorite:vi.fn(),onStatus:vi.fn(),onDirection:vi.fn(),onDelete:vi.fn(),onRestore:vi.fn(),onRefresh:vi.fn(),onSettings:vi.fn()})
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api).mockResolvedValue([]) })
afterEach(cleanup)

it('用中文速览说明论文，同时保留原题、状态和阅读入口，打开页面不调用模型', () => {
  const callbacks = props(), view = render(<PaperLibraryCard paper={paper} {...callbacks} />)
  expect(view.getByRole('heading', {name:paper.card_preview!.headline})).toBeTruthy()
  expect(view.getByText(paper.title)).toBeTruthy()
  expect(view.getByText('研究问题')).toBeTruthy(); expect(view.getByText('核心做法')).toBeTruthy(); expect(view.getByText('主要价值')).toBeTruthy()
  fireEvent.click(view.getByRole('button',{name:'查看阅读卡片'})); expect(callbacks.onCard).toHaveBeenCalledOnce()
  fireEvent.click(view.getByRole('button',{name:'继续阅读 · 第 2 页'})); expect(callbacks.onOpen).toHaveBeenCalledOnce()
  fireEvent.click(view.getByRole('button',{name:'个性化生成'})); expect(callbacks.onDirection).toHaveBeenCalledWith(1)
  expect(readingApi).not.toHaveBeenCalled()
})

it('旧卡片显式生成速览，提交响应丢失时复用同一请求标识', async () => {
  const callbacks = props(), old = {...paper, card_preview:null, card_brief:{problem:'旧问题',approach:'旧方法',benefit:'旧结果'}}
  vi.mocked(readingApi).mockRejectedValueOnce(new Error('连接中断')).mockResolvedValueOnce({id:'c'.repeat(32),status:'succeeded',progress:100,error_message:null})
  const view = render(<PaperLibraryCard paper={old} {...callbacks} />)
  await waitFor(() => expect(api).toHaveBeenCalledOnce())
  expect(readingApi).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button',{name:'生成简明速览'}))
  await view.findByRole('alert')
  fireEvent.click(view.getByRole('button',{name:'重试速览请求'}))
  await waitFor(() => expect(callbacks.onRefresh).toHaveBeenCalledOnce())
  const calls = vi.mocked(readingApi).mock.calls
  expect(JSON.parse(calls[0][1]!.body as string).request_id).toBe(JSON.parse(calls[1][1]!.body as string).request_id)
})

it('无卡片和回收站保留正确入口，个人记录不会直接触发 AI', () => {
  const callbacks = props(), view = render(<PaperLibraryCard paper={{...paper,card_summary:null,card_preview:null,card_status:null}} {...callbacks} />)
  fireEvent.click(view.getByRole('button',{name:'生成或填写阅读卡片'})); expect(callbacks.onCard).toHaveBeenCalledOnce()
  view.rerender(<PaperLibraryCard paper={paper} {...callbacks} trash />)
  fireEvent.click(view.getByRole('button',{name:'恢复论文'})); expect(callbacks.onRestore).toHaveBeenCalledOnce()
  expect(readingApi).not.toHaveBeenCalled()
})

it('重新整理失败时显示原因并继续保留原速览', async () => {
  vi.mocked(readingApi).mockRejectedValueOnce(new Error('任务预算不足'))
  const view=render(<PaperLibraryCard paper={paper} {...props()} />)
  fireEvent.click(view.getByRole('button',{name:'重新整理简明速览'}))
  expect((await view.findByRole('alert')).textContent).toContain('任务预算不足')
  expect(view.getByRole('heading',{name:paper.card_preview!.headline})).toBeTruthy()
  expect(JSON.parse(vi.mocked(readingApi).mock.calls[0][1]!.body as string).regenerate).toBe(true)
})

it('已有速览重新整理时可以取消并继续查看原内容', async () => {
  const queued={id:'c'.repeat(32),status:'queued',error_message:null}
  vi.mocked(readingApi).mockResolvedValueOnce(queued).mockResolvedValueOnce({...queued,status:'cancelled'})
  const view=render(<PaperLibraryCard paper={paper} {...props()} />)
  fireEvent.click(view.getByRole('button',{name:'重新整理简明速览'}))
  fireEvent.click(await view.findByRole('button',{name:'取消整理'}))
  await waitFor(()=>expect(view.queryByRole('button',{name:'取消整理'})).toBeNull())
  expect(view.getByRole('heading',{name:paper.card_preview!.headline})).toBeTruthy()
  expect(vi.mocked(readingApi).mock.calls[1][0]).toBe(`/card-tasks/${queued.id}/cancel`)
})

it('晚到的旧任务列表不会覆盖刚提交的整理任务', async () => {
  let resolveList!: (value:unknown[])=>void
  vi.mocked(api).mockImplementationOnce(()=>new Promise(resolve=>{resolveList=resolve}))
  vi.mocked(readingApi).mockResolvedValueOnce({id:'c'.repeat(32),status:'queued',error_message:null})
  const view=render(<PaperLibraryCard paper={paper} {...props()} />)
  fireEvent.click(view.getByRole('button',{name:'重新整理简明速览'}))
  await view.findByRole('button',{name:'取消整理'})
  resolveList([{id:'d'.repeat(32),status:'succeeded',error_message:null}])
  await waitFor(()=>expect(view.getByRole('button',{name:'重新整理简明速览'}).hasAttribute('disabled')).toBe(true))
  expect(view.getByRole('button',{name:'取消整理'})).toBeTruthy()
})

import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ReaderWorkspace from './ReaderWorkspace'
import { api, readingApi, type Paper } from '../api'

const probe = vi.hoisted(() => ({ jump: null as any, pdf: { numPages: 3 } }))
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(probe.pdf), destroy: () => Promise.resolve() }) }))
vi.mock('../api', async () => ({ ...await vi.importActual('../api'), api: vi.fn(), readingApi: vi.fn() }))
vi.mock('./NotesPanel', () => ({ default: () => { const [text,setText]=useState(''); return <input aria-label="模拟阅读笔记" value={text} onChange={event=>setText(event.target.value)} /> } }))
vi.mock('./PdfDocument', () => ({ default: function Document(props: any) {
  probe.jump = props.jump
  useEffect(() => props.onReady(props.value.page_number, 1), [props.value.page_number])
  return <div><button onClick={() => { props.onPageChange(2); props.onVisiblePages([1, 2, 3]) }}>模拟滚动到第二页</button><button onClick={()=>props.onSelection({quote:'Retrieval augmented generation',page_number:1,page_source_id:'source',rects:[[1,2,3,4]]})}>模拟选择原文</button>{props.selectionActions}</div>
} }))
const paper = { id: 'paper', title: '连续阅读测试', page_count: 3, file_hash: 'hash' } as Paper
const position = { page_number: 1, zoom_mode: 'fit_width', zoom: null, view_rotation: 0, revision: 1 }
beforeEach(() => {
  probe.jump = null; vi.clearAllMocks(); localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.mocked(api).mockImplementation(async path => path.endsWith('/reader-open') ? { position, read_only: false, file_hash: 'hash', page_sources: [] } : path === '/settings/translation' ? {enabled:true,model:'Qwen/Qwen3.5-9B',timeout_seconds:60,base_url:'http://47.100.90.123:8008/v1'} : path.endsWith('/translation') ? {translation:'检索增强生成',model:'Qwen/Qwen3.5-9B',cached:false} : { items: [], total: 0, page: 1, page_size: 200 })
  vi.mocked(readingApi).mockImplementation(async (_path, options) => ({ ...JSON.parse(options?.body as string), revision: 2 }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function opened() {
  const result = render(<ReaderWorkspace paper={paper} enabled={true} onOpened={vi.fn()} />)
  await result.findByRole('button', { name: '模拟滚动到第二页' })
  return result
}
it('滚轮跨页同步工具栏，并通过原有自动保存队列保存第 2 页', async () => {
  const result = await opened()
  vi.useFakeTimers()
  fireEvent.click(result.getByRole('button', { name: '模拟滚动到第二页' }))
  expect((result.getByLabelText('PDF 页码') as HTMLInputElement).value).toBe('2')
  await act(() => vi.advanceTimersByTimeAsync(1000))
  const call = vi.mocked(readingApi).mock.calls.find(([path]) => path.endsWith('/position'))!
  expect(JSON.parse(call[1]?.body as string)).toMatchObject({ page_number: 2, file_hash: 'hash', revision: 1 })
  expect(vi.mocked(api).mock.calls.filter(([path]) => path.includes('/annotations?')).map(([path]) => new URLSearchParams(path.split('?')[1]).get('page_number'))).toContain('3')
})
it('确认页码后再失焦不会重新定位，保持滚动后的页内位置', async () => {
  const result = await opened(), input = result.getByLabelText('PDF 页码')
  fireEvent.change(input, { target: { value: '2' } }); fireEvent.keyDown(input, { key: 'Enter' })
  const jump = probe.jump
  expect(jump).toEqual({ page: 2, nonce: 1 })
  fireEvent.blur(input)
  expect(probe.jump).toBe(jump)
})
it('选区翻译移入侧栏，跨页、收起和重新打开均保留译文与原页',async()=>{
  const result=await opened()
  fireEvent.click(result.getByRole('button',{name:'模拟选择原文'}))
  expect(vi.mocked(api).mock.calls.some(([path])=>path.endsWith('/translation'))).toBe(false)
  fireEvent.click(result.getByRole('button',{name:'翻译'}))
  await result.findByText('检索增强生成')
  expect(result.queryByRole('region',{name:'文字选区操作'})).toBeNull()
  fireEvent.click(result.getByRole('button',{name:'模拟滚动到第二页'}))
  expect(result.getByText('检索增强生成')).toBeTruthy()
  expect(result.getByText('原文 · 第 1 页 · 30 字符')).toBeTruthy()
  fireEvent.click(result.getByRole('button',{name:'收起阅读侧栏'}))
  fireEvent.click(result.getByRole('button',{name:'翻译侧栏'}))
  expect(result.getByRole('tab',{name:'译文'}).getAttribute('aria-selected')).toBe('true')
  expect(result.getByText('检索增强生成')).toBeTruthy()
  expect(vi.mocked(api).mock.calls.filter(([path])=>path==='/papers/paper/translation')).toHaveLength(1)
})
it('译文和记录切换保持已输入笔记，空侧栏不会自动调用模型',async()=>{
  const result=await opened()
  fireEvent.click(result.getByRole('button',{name:'记录'}))
  fireEvent.change(result.getByLabelText('模拟阅读笔记'),{target:{value:'尚未完成的理解'}})
  fireEvent.click(result.getByRole('tab',{name:'译文'}))
  await result.findByText('划词翻译')
  expect(vi.mocked(api).mock.calls.some(([path])=>path==='/papers/paper/translation')).toBe(false)
  fireEvent.click(result.getByRole('tab',{name:'记录'}))
  expect((result.getByLabelText('模拟阅读笔记') as HTMLInputElement).value).toBe('尚未完成的理解')
})

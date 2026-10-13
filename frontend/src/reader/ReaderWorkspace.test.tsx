import { useEffect } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ReaderWorkspace from './ReaderWorkspace'
import { api, readingApi, type Paper } from '../api'

const probe = vi.hoisted(() => ({ jump: null as any, pdf: { numPages: 3 } }))
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(probe.pdf), destroy: () => Promise.resolve() }) }))
vi.mock('../api', async () => ({ ...await vi.importActual('../api'), api: vi.fn(), readingApi: vi.fn() }))
vi.mock('./NotesPanel', () => ({ default: () => null }))
vi.mock('./PdfDocument', () => ({ default: function Document(props: any) {
  probe.jump = props.jump
  useEffect(() => props.onReady(props.value.page_number, 1), [props.value.page_number])
  return <button onClick={() => { props.onPageChange(2); props.onVisiblePages([1, 2, 3]) }}>模拟滚动到第二页</button>
} }))
const paper = { id: 'paper', title: '连续阅读测试', page_count: 3, file_hash: 'hash' } as Paper
const position = { page_number: 1, zoom_mode: 'fit_width', zoom: null, view_rotation: 0, revision: 1 }
beforeEach(() => {
  probe.jump = null; vi.clearAllMocks()
  vi.mocked(api).mockImplementation(async path => path.endsWith('/reader-open') ? { position, read_only: false, file_hash: 'hash', page_sources: [] } : { items: [], total: 0, page: 1, page_size: 200 })
  vi.mocked(readingApi).mockImplementation(async (_path, options) => ({ ...JSON.parse(options?.body as string), revision: 2 }))
})
afterEach(() => { cleanup(); vi.useRealTimers() })
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

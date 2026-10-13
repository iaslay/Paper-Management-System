import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import PdfDocument, { type PageJump } from './PdfDocument'
import type { PageSource, PositionValue } from './types'

const probe = vi.hoisted(() => ({ pages: new Map<number, any>() }))
vi.mock('./PdfPage', () => ({ default: function Page(props: any) {
  probe.pages.set(props.value.page_number, props)
  useEffect(() => { props.onReady(props.value.page_number, props.scale); return () => { probe.pages.delete(props.value.page_number) } }, [props.value.page_number, props.scale])
  return <canvas aria-label={`原文第 ${props.value.page_number} 页`} />
} }))
let resize: () => void, width = 832, height = 600
beforeEach(() => {
  probe.pages.clear(); width = 832; height = 600
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() { resize() } disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)
  Element.prototype.scrollTo = function(options?: ScrollToOptions | number, y?: number) { this.scrollTop = typeof options === 'number' ? y! : options?.top || 0; this.scrollLeft = typeof options === 'number' ? options : options?.left || 0 }
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const pdf = { numPages: 100, getPage: vi.fn() } as unknown as PDFDocumentProxy
const sources: PageSource[] = Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1), paper_id: 'paper', file_hash: 'hash', page_number: index + 1, view_box: [0, 0, 400, 600], intrinsic_rotation: 0, user_unit: 1 }))
const value: PositionValue = { page_number: 1, zoom_mode: 'fit_width', zoom: null, view_rotation: 0 }
const change = vi.fn(), ready = vi.fn(), visible = vi.fn()
function view(position = value, jump: PageJump | null = null) { return <PdfDocument pdf={pdf} value={position} sources={sources} annotations={[]} readOnly={false} onReady={ready} onSelection={vi.fn()} onPageChange={change} onVisiblePages={visible} jump={jump} searchHit={null} focusAnnotation={null} /> }
async function opened(position = value) { change.mockClear(); ready.mockClear(); visible.mockClear(); const result = render(view(position)); await result.findByLabelText(`原文第 ${position.page_number} 页`); return result }

it('全部页面占位连续排列，滚动跨页更新页码而不创建百张画布', async () => {
  const result = await opened(), area = result.getByLabelText('论文连续阅读区域')
  expect(result.container.querySelectorAll('[data-page-number]').length).toBe(100)
  area.scrollTop = 1216 + 16; fireEvent.scroll(area)
  await waitFor(() => expect(change).toHaveBeenLastCalledWith(2))
  expect(result.container.querySelectorAll('canvas').length).toBeLessThanOrEqual(4)
  expect(visible).toHaveBeenLastCalledWith([1, 2, 3])
  // 普通滚动时不会因当前页属性更新而重新跳到页首。
  area.scrollTop += 330; fireEvent.scroll(area)
  result.rerender(view({ ...value, page_number: 2 }))
  expect(area.scrollTop).toBe(1562)
})
it('恢复远处的已保存页，只渲染目标附近，页码跳转和重复定位仍有效', async () => {
  const result = await opened({ ...value, page_number: 50 }), area = result.getByLabelText('论文连续阅读区域')
  expect(area.scrollTop).toBe(49 * 1216 + 16)
  expect(probe.pages.has(1)).toBe(false); expect(probe.pages.has(50)).toBe(true)
  result.rerender(view({ ...value, page_number: 20 }, { page: 20, nonce: 1 }))
  await waitFor(() => expect(area.scrollTop).toBe(19 * 1216 + 16))
  area.scrollTop += 300; fireEvent.scroll(area)
  result.rerender(view({ ...value, page_number: 20 }, { page: 20, nonce: 2 }))
  expect(area.scrollTop).toBe(19 * 1216 + 16)
})
it('侧栏和缩放改变页面高度时保留页内相对位置，隐藏阅读器不丢进度', async () => {
  const result = await opened({ ...value, page_number: 3 }), area = result.getByLabelText('论文连续阅读区域')
  area.scrollTop += 300; fireEvent.scroll(area)
  width = 432; act(() => resize())
  expect(area.scrollTop).toBe(2 * 616 + 150 + 16)
  width = 0; height = 0; act(() => resize())
  expect(result.queryByLabelText('原文第 3 页')).toBeTruthy()
  width = 432; height = 600; act(() => resize())
  expect(area.scrollTop).toBe(1398)
  result.rerender(view({ ...value, page_number: 3, zoom_mode: 'custom', zoom: 2 }))
  expect(area.scrollTop).toBe(2 * 1216 + 300 + 16)
})
it('搜索与高亮坐标定位合并页偏移，跳到第五页正文而不是第一页', async () => {
  const result = await opened({ ...value, page_number: 5 }), area = result.getByLabelText('论文连续阅读区域')
  act(() => probe.pages.get(5).onLocate(5, [20, 480, 80, 510]))
  expect(area.scrollTop).toBe(4 * 1216 + 400 + 16)
})
it('长文旋转后滚动范围变短，即使浏览器先截断位置仍停留在原页', async () => {
  const result = await opened({ ...value, page_number: 90 }), area = result.getByLabelText('论文连续阅读区域')
  area.scrollTop += 300; fireEvent.scroll(area)
  // 模拟布局变短时浏览器先截断滚动位置、尚未派发滚动事件。
  area.scrollTop = 30000
  result.rerender(view({ ...value, page_number: 90, view_rotation: 90 }))
  expect(area.scrollTop).toBeCloseTo(89 * (800 * 400 / 600 + 16) + 300 * (800 * 400 / 600) / 1200 + 16)
  expect(change).not.toHaveBeenCalledWith(25)
})
it('拖选页暂时保留，远距离滚动仍限制画布数量', async () => {
  const result = await opened(), area = result.getByLabelText('论文连续阅读区域')
  fireEvent.pointerDown(result.getByLabelText('原文第 1 页'))
  area.scrollTop = 49 * 1216 + 16; fireEvent.scroll(area)
  await result.findByLabelText('原文第 50 页')
  expect(result.queryByLabelText('原文第 1 页')).toBeTruthy()
  expect(result.container.querySelectorAll('canvas').length).toBeLessThanOrEqual(5)
  fireEvent.pointerDown(result.getByLabelText('原文第 50 页'))
  await waitFor(() => expect(result.queryByLabelText('原文第 1 页')).toBeNull())
})
it('末页比视野短，滚到底部仍更新为最后一页而不是停在倒数第二页', async () => {
  height = 1500
  const result = await opened(), area = result.getByLabelText('论文连续阅读区域')
  const documentHeight = 99 * 1216 + 1200 + 32
  Object.defineProperty(area, 'scrollHeight', { value: documentHeight, configurable: true })
  area.scrollTop = documentHeight - height; fireEvent.scroll(area)
  await waitFor(() => expect(change).toHaveBeenLastCalledWith(100))
})

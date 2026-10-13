import { StrictMode, useRef } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTextSelection } from './useTextSelection'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 16))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
function Probe({ commit, clear }: { commit: () => void; clear: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  useTextSelection(root, commit, clear)
  return <div ref={root} data-testid="layer"><span>图像页中的隐藏文字层</span></div>
}
function pointer(target: Document | HTMLElement, type: string, id = 1, button = 0) {
  const event = new Event(type, { bubbles: true })
  Object.defineProperties(event, { pointerId: { value: id }, button: { value: button }, isPrimary: { value: true } })
  fireEvent(target, event)
}
it('拖选途中不提交，松开在页面外仍只读取最终选区', () => {
  const commit = vi.fn(), clear = vi.fn(), view = render(<Probe commit={commit} clear={clear} />)
  pointer(view.getByTestId('layer'), 'pointerdown')
  fireEvent(document, new Event('selectionchange'))
  act(() => vi.advanceTimersByTime(300))
  expect(commit).not.toHaveBeenCalled(); expect(clear).toHaveBeenCalledTimes(1)
  expect(view.getByTestId('layer').classList.contains('selecting')).toBe(true)
  pointer(document, 'pointerup')
  fireEvent(document, new Event('selectionchange'))
  act(() => vi.advanceTimersByTime(100))
  expect(commit).toHaveBeenCalledTimes(1)
  expect(view.getByTestId('layer').classList.contains('selecting')).toBe(false)
})
it('键盘及选择手柄连续变化合并后读取，回调使用最新数据', () => {
  const commit = vi.fn(), next = vi.fn(), clear = vi.fn(), view = render(<Probe commit={commit} clear={clear} />)
  fireEvent(document, new Event('selectionchange')); act(() => vi.advanceTimersByTime(50))
  view.rerender(<Probe commit={next} clear={clear} />)
  fireEvent(document, new Event('selectionchange')); act(() => vi.advanceTimersByTime(100))
  expect(commit).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledTimes(1)
})
it('取消、失焦和卸载清理拖选及延迟任务，严格模式不重复监听', () => {
  const commit = vi.fn(), clear = vi.fn(), view = render(<StrictMode><Probe commit={commit} clear={clear} /></StrictMode>)
  const layer = view.getByTestId('layer')
  pointer(layer, 'pointerdown'); pointer(document, 'pointercancel')
  expect(clear).toHaveBeenCalledTimes(2)
  pointer(layer, 'pointerdown'); fireEvent(window, new Event('blur'))
  expect(clear).toHaveBeenCalledTimes(4)
  fireEvent(document, new Event('selectionchange')); view.unmount()
  act(() => vi.advanceTimersByTime(300)); expect(commit).not.toHaveBeenCalled()
  fireEvent(document, new Event('selectionchange')); act(() => vi.advanceTimersByTime(300))
  expect(commit).not.toHaveBeenCalled()
})
it('其他指针的释放和右键不会结束当前拖选', () => {
  const commit = vi.fn(), clear = vi.fn(), view = render(<Probe commit={commit} clear={clear} />)
  pointer(view.getByTestId('layer'), 'pointerdown', 2, 2); expect(clear).not.toHaveBeenCalled()
  pointer(view.getByTestId('layer'), 'pointerdown', 1)
  pointer(document, 'pointerup', 2); act(() => vi.advanceTimersByTime(200))
  expect(commit).not.toHaveBeenCalled()
  pointer(document, 'pointerup', 1); act(() => vi.advanceTimersByTime(16))
  expect(commit).toHaveBeenCalledTimes(1)
})

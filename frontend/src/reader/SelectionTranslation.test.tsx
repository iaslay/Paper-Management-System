import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SelectionTranslation from './SelectionTranslation'
import SelectionToolbar from './SelectionToolbar'
import { api, type Paper } from '../api'
import type { SelectionValue } from './types'

vi.mock('../api', () => ({ api: vi.fn() }))
const paper = { id: 'paper', file_hash: 'hash' } as Paper
const selection: SelectionValue = { quote: 'structured memory', page_number: 3, page_source_id: 'source', rects: [[1, 2, 3, 4]] }
const config = { enabled: true, model: 'Qwen/Qwen3.5-9B', base_url: 'http://47.100.90.123:8008/v1', timeout_seconds: 60, max_characters: 2000 }
const result = { translation: '结构化记忆', model: config.model, cached: false }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api).mockImplementation(async path => path === '/settings/translation' ? config : result)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function opened() { const rendered = render(<SelectionTranslation paper={paper} selection={selection} />); await rendered.findByText(/仅发送选中文字/); return rendered }
it('只在点击翻译时发送选中文字、页码和原文版本，显示并复制译文', async () => {
  const rendered = await opened()
  expect(api).toHaveBeenCalledTimes(1)
  fireEvent.click(rendered.getByRole('button', { name: '翻译' }))
  await rendered.findByText('结构化记忆')
  const call = vi.mocked(api).mock.calls[1]
  expect(call[0]).toBe('/papers/paper/translation')
  expect(JSON.parse(call[1]?.body as string)).toEqual({ quote: selection.quote, page_number: 3, file_hash: 'hash' })
  const copy = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText: copy } })
  fireEvent.click(rendered.getByRole('button', { name: '复制译文' }))
  await rendered.findByText('已复制'); expect(copy).toHaveBeenCalledWith('结构化记忆')
})
it('取消后晚到译文被忽略，并能重新发起翻译', async () => {
  let resolve!: (value: unknown) => void
  vi.mocked(api).mockImplementation(path => path === '/settings/translation' ? Promise.resolve(config) : new Promise(done => { resolve = done }))
  const rendered = await opened()
  fireEvent.click(rendered.getByRole('button', { name: '翻译' }))
  const signal = vi.mocked(api).mock.calls[1][1]?.signal
  fireEvent.click(rendered.getByRole('button', { name: '取消翻译' }))
  expect(signal?.aborted).toBe(true)
  await act(async () => resolve(result))
  expect(rendered.queryByText('结构化记忆')).toBeNull()
  expect(rendered.getByText('已取消翻译')).toBeTruthy()
  vi.mocked(api).mockResolvedValue(result)
  fireEvent.click(rendered.getByRole('button', { name: '重试翻译' }))
  await rendered.findByText('结构化记忆')
})
it('更换选区时取消旧请求，旧结果不会覆盖新选区', async () => {
  let resolve!: (value: unknown) => void
  vi.mocked(api).mockImplementation(path => path === '/settings/translation' ? Promise.resolve(config) : new Promise(done => { resolve = done }))
  const rendered = await opened()
  fireEvent.click(rendered.getByRole('button', { name: '翻译' }))
  const signal = vi.mocked(api).mock.calls[1][1]?.signal
  rendered.rerender(<SelectionTranslation paper={paper} selection={{ ...selection, quote: 'new phrase' }} />)
  expect(signal?.aborted).toBe(true)
  await act(async () => resolve(result))
  expect(rendered.queryByText('结构化记忆')).toBeNull()
  expect(rendered.getByRole('button', { name: '翻译' })).toBeTruthy()
})
it('服务错误后可重试，复制权限不足时提供手动复制', async () => {
  const rendered = await opened()
  vi.mocked(api).mockRejectedValueOnce(new Error('翻译服务繁忙'))
  fireEvent.click(rendered.getByRole('button', { name: '翻译' }))
  await rendered.findByRole('alert')
  fireEvent.click(rendered.getByRole('button', { name: '重试翻译' }))
  await rendered.findByText('结构化记忆')
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
  fireEvent.click(rendered.getByRole('button', { name: '复制译文' }))
  await rendered.findByLabelText('手动复制译文')
})
it('只读选区也能打开翻译侧栏，退出键先关闭选区操作', async () => {
  const close = vi.fn(), translate = vi.fn()
  const rendered = render(<SelectionToolbar selection={{ ...selection, page_source_id: null, rects: [] }} canHighlight={false} onCreate={vi.fn()} onClose={close} onTranslate={translate} />)
  expect((rendered.getByRole('button', { name: '保存高亮' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(rendered.getByRole('button', { name: '翻译' }))
  expect(translate).toHaveBeenCalledOnce(); expect(api).not.toHaveBeenCalled()
  fireEvent.keyDown(document, { key: 'Escape' }); expect(close).toHaveBeenCalledOnce()
})
it('离开阅读器后中断翻译，忽略晚到结果', async () => {
  const rendered = await opened()
  vi.mocked(api).mockImplementation(() => new Promise(() => {}))
  fireEvent.click(rendered.getByRole('button', { name: '翻译' }))
  const signal = vi.mocked(api).mock.calls[1][1]?.signal
  rendered.unmount(); expect(signal?.aborted).toBe(true)
})
it('显式选区翻译请求等配置读取完后执行一次，重复渲染不重复调用', async () => {
  const rendered = render(<SelectionTranslation paper={paper} selection={selection} request={1} />)
  await rendered.findByText('结构化记忆')
  expect(vi.mocked(api).mock.calls.filter(([path])=>path.endsWith('/translation') && path!== '/settings/translation')).toHaveLength(1)
  rendered.rerender(<SelectionTranslation paper={paper} selection={selection} request={1} />)
  expect(vi.mocked(api).mock.calls).toHaveLength(2)
})
it('前端等待超时中断请求并显示可重试的中文提示', async () => {
  const rendered = await opened()
  vi.useFakeTimers()
  vi.mocked(api).mockImplementation((_path, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
  fireEvent.click(rendered.getByRole('button', { name: '翻译' }))
  await act(() => vi.advanceTimersByTimeAsync(63000))
  expect(rendered.getByRole('alert').textContent).toContain('翻译等待超时')
})
it('侧栏译文渲染公式，复制和手动复制均保留完整 LaTeX 原文', async () => {
  const translation = String.raw`给定话语 $U_t$，记忆摘要为：
\[M_t = \Phi_{\text{memory}}(U_t,H^{1:k-1})\]`
  vi.mocked(api).mockImplementation(async path => path === '/settings/translation' ? config : { ...result, translation })
  const rendered = await opened()
  fireEvent.click(rendered.getByRole('button', { name: '翻译' }))
  await rendered.findByText('中文译文')
  expect(rendered.container.querySelectorAll('.reader-translation-result .katex')).toHaveLength(2)
  const copy = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText: copy } })
  fireEvent.click(rendered.getByRole('button', { name: '复制译文' }))
  await rendered.findByText('已复制')
  expect(copy).toHaveBeenCalledWith(translation)
  copy.mockRejectedValueOnce(new Error('denied'))
  fireEvent.click(rendered.getByRole('button', { name: '已复制' }))
  const textarea = await rendered.findByLabelText('手动复制译文') as HTMLTextAreaElement
  expect(textarea.value).toBe(translation)
})

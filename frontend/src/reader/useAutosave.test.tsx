import { StrictMode } from 'react'
import { render, fireEvent, act, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAutosave } from './useAutosave'
import type { RegisterSave } from './types'

afterEach(() => { cleanup(); vi.useRealTimers() })
it('严格模式重挂载和会话暂停不会重复创建或丢失输入', async () => {
  vi.useFakeTimers()
  const writer = vi.fn(async (value: string) => ({ content: value, revision: 1 }))
  const register: RegisterSave = () => () => {}
  function Probe({ enabled }: { enabled: boolean }) {
    const { queue, state } = useAutosave({ value: '', remote: null as { content: string; revision: number } | null, key: 'probe', label: '测试笔记', text: value => value, enabled, register, writer, validate: value => value ? null : '请输入内容' })
    return <textarea aria-label="测试笔记" value={state.draft} onChange={event => queue.set(event.target.value)} />
  }
  const view = render(<StrictMode><Probe enabled /></StrictMode>)
  fireEvent.change(view.getByLabelText('测试笔记'), { target: { value: '保留我的草稿' } })
  view.rerender(<StrictMode><Probe enabled={false} /></StrictMode>)
  await act(() => vi.advanceTimersByTimeAsync(2000)); expect(writer).not.toHaveBeenCalled()
  expect((view.getByLabelText('测试笔记') as HTMLTextAreaElement).value).toBe('保留我的草稿')
  view.rerender(<StrictMode><Probe enabled /></StrictMode>)
  await act(() => vi.advanceTimersByTimeAsync(1000)); expect(writer).toHaveBeenCalledTimes(1)
})

import { StrictMode } from 'react'
import { render, fireEvent, act, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAutosave } from './useAutosave'
import type { RegisterSave, SaveControl } from './types'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('保存状态接口持续反映失败与重试结果，收起记录面板后仍可识别异常',async()=>{
  let control!:SaveControl
  const register:RegisterSave=(_key,value)=>{control=value;return()=>{}}
  const writer=vi.fn().mockRejectedValueOnce(new Error('验收：保存失败')).mockResolvedValue({content:'需要保留的内容',revision:2})
  function Probe(){
    const {queue,state}=useAutosave({value:'',remote:null as {content:string;revision:number}|null,key:'note',label:'测试笔记',text:value=>value,enabled:true,register,writer,validate:()=>null})
    return <textarea aria-label="待保存笔记" value={state.draft} onChange={event=>queue.set(event.target.value)} />
  }
  const view=render(<Probe />)
  fireEvent.change(view.getByLabelText('待保存笔记'),{target:{value:'需要保留的内容'}})
  await act(async()=>{await control.flush()})
  expect(control.status?.().phase).toBe('failed');expect(control.status?.().error?.message).toContain('保存失败')
  expect((view.getByLabelText('待保存笔记') as HTMLTextAreaElement).value).toBe('需要保留的内容')
  await act(async()=>{await control.flush()})
  expect(control.status?.().phase).toBe('saved');expect(control.status?.().error).toBeNull()
})
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

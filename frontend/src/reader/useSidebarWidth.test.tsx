import { useRef } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSidebarWidth } from './useSidebarWidth'

function Harness() {
  const ref=useRef<HTMLDivElement>(null), sidebar=useSidebarWidth(ref,false)
  return <div ref={element=>{ref.current=element;if(element)Object.defineProperty(element,'clientWidth',{value:1200,configurable:true})}} style={sidebar.style}><div {...sidebar.resizeProps} /></div>
}
beforeEach(()=>{ localStorage.clear(); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }) })
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
it('键盘调整宽度受限，重新打开后采用保存的偏好',()=>{
  let view=render(<Harness />),handle=view.getByRole('separator',{name:'调整阅读侧栏宽度'})
  fireEvent.keyDown(handle,{key:'ArrowLeft'})
  expect(handle.getAttribute('aria-valuenow')).toBe('400')
  view.unmount();view=render(<Harness />);handle=view.getByRole('separator',{name:'调整阅读侧栏宽度'})
  expect(handle.getAttribute('aria-valuenow')).toBe('400')
  fireEvent.keyDown(handle,{key:'Home'});fireEvent.keyDown(handle,{key:'ArrowRight'})
  expect(handle.getAttribute('aria-valuenow')).toBe('280')
  fireEvent.keyDown(handle,{key:'End'});fireEvent.keyDown(handle,{key:'ArrowLeft'})
  expect(handle.getAttribute('aria-valuenow')).toBe('720')
  fireEvent.doubleClick(handle);expect(handle.getAttribute('aria-valuenow')).toBe('380')
})
it('拖动左边缘调整宽度，松开后继续移动不会改变已保存宽度',()=>{
  const view=render(<Harness />),handle=view.getByRole('separator',{name:'调整阅读侧栏宽度'})
  fireEvent.pointerDown(handle,{button:0,pointerId:1,clientX:800})
  fireEvent.pointerMove(handle,{pointerId:1,clientX:700})
  expect(handle.getAttribute('aria-valuenow')).toBe('480')
  fireEvent.pointerUp(handle,{pointerId:1})
  fireEvent.pointerMove(handle,{pointerId:1,clientX:600})
  expect(handle.getAttribute('aria-valuenow')).toBe('480')
})

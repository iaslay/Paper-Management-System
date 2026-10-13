import { useEffect, useRef, type RefObject } from 'react'

// 浏览器负责原生文字拖选；松开指针后再显示操作，避免选区途中重排界面。
export function useTextSelection(root: RefObject<HTMLElement | null>, commit: () => void, clear: () => void) {
  const callbacks = useRef({ commit, clear }); callbacks.current = { commit, clear }
  useEffect(() => {
    const layer = root.current
    if (!layer) return
    let pointer: number | null = null, timer: number | null = null, frame: number | null = null
    function stopScheduled() {
      if (timer !== null) window.clearTimeout(timer)
      if (frame !== null) window.cancelAnimationFrame(frame)
      timer = frame = null
    }
    function start(event: PointerEvent) {
      if (event.button !== 0 || !event.isPrimary) return
      stopScheduled(); pointer = event.pointerId
      layer!.classList.add('selecting'); callbacks.current.clear()
    }
    function finish(event: PointerEvent) {
      if (pointer !== event.pointerId) return
      pointer = null; layer!.classList.remove('selecting'); stopScheduled()
      frame = window.requestAnimationFrame(() => { frame = null; callbacks.current.commit() })
    }
    function cancel() {
      pointer = null; stopScheduled(); layer!.classList.remove('selecting')
    }
    function cancelPointer(event: PointerEvent) { if (pointer === event.pointerId) { cancel(); callbacks.current.clear() } }
    function changed() {
      if (pointer !== null) return
      stopScheduled()
      // 键盘扩选及触屏选择手柄也会触发选区变化，稍后读取最终结果。
      timer = window.setTimeout(() => { timer = null; callbacks.current.commit() }, 100)
    }
    function blurred() { cancel(); callbacks.current.clear() }
    layer.addEventListener('pointerdown', start)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', cancelPointer)
    document.addEventListener('selectionchange', changed)
    window.addEventListener('blur', blurred)
    return () => {
      cancel(); layer.removeEventListener('pointerdown', start)
      document.removeEventListener('pointerup', finish); document.removeEventListener('pointercancel', cancelPointer)
      document.removeEventListener('selectionchange', changed); window.removeEventListener('blur', blurred)
    }
  }, [root])
}

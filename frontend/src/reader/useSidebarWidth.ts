import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'

const preferenceKey = 'paperboard-reader-sidebar-width'
const minimum = 280, maximum = 720, defaultWidth = 380
function savedWidth() {
  try { const value = Number(localStorage.getItem(preferenceKey)); return Number.isFinite(value) && value >= minimum ? Math.min(maximum, value) : defaultWidth } catch { return defaultWidth }
}

export function useSidebarWidth(container: RefObject<HTMLDivElement | null>, navigation: boolean) {
  const [preferred, setPreferred] = useState(savedWidth), [limit, setLimit] = useState(maximum)
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null)
  const width = Math.min(preferred, limit)
  useEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => {
      if (element.clientWidth <= 0) return
      const navigationWidth = element.querySelector('.reader-navigation, .reader-search-panel')?.getBoundingClientRect().width || 0
      // 调整侧栏时为原文保留阅读宽度；窄屏由样式切换为上下布局。
      setLimit(Math.max(minimum, Math.min(maximum, element.clientWidth - navigationWidth - 320)))
    }
    measure(); const observer = new ResizeObserver(measure); observer.observe(element)
    return () => observer.disconnect()
  }, [container, navigation])
  function update(value: number) { const next = Math.round(Math.max(minimum, Math.min(limit, value))); setPreferred(next); try { localStorage.setItem(preferenceKey, String(next)) } catch { /* 无法保存偏好时仍可调整当前侧栏。 */ } }
  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault(); drag.current = { pointer: event.pointerId, x: event.clientX, width }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  function move(event: PointerEvent<HTMLDivElement>) { if (drag.current?.pointer === event.pointerId) update(drag.current.width + drag.current.x - event.clientX) }
  function end(event: PointerEvent<HTMLDivElement>) { if (drag.current?.pointer === event.pointerId) drag.current = null }
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const next = event.key === 'ArrowLeft' ? width + 20 : event.key === 'ArrowRight' ? width - 20 : event.key === 'Home' ? minimum : event.key === 'End' ? limit : null
    if (next !== null) { event.preventDefault(); update(next) }
  }
  return { style: { '--reader-sidebar-width': `${width}px` } as CSSProperties, resizeProps: { role: 'separator', 'aria-label': '调整阅读侧栏宽度', 'aria-orientation': 'vertical' as const, 'aria-valuemin': minimum, 'aria-valuemax': limit, 'aria-valuenow': width, tabIndex: 0, onPointerDown: start, onPointerMove: move, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: () => { drag.current = null }, onKeyDown: keys, onDoubleClick: () => update(defaultWidth) } }
}

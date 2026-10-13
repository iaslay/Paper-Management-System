import type { PageViewport } from 'pdfjs-dist/types/src/display/page_viewport'
import type { Rect } from './types'

function bounding(points: number[][]): Rect {
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))]
}
function corners(rect: Rect) { const [x0, y0, x1, y1] = rect; return [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] }
export function toPdfRect(viewport: PageViewport, rect: Rect): Rect { return bounding(corners(rect).map(([x, y]) => viewport.convertToPdfPoint(x, y))) }
export function toViewRect(viewport: PageViewport, rect: Rect): Rect { return bounding(corners(rect).map(([x, y]) => viewport.convertToViewportPoint(x, y))) }
export function validRect(rect: Rect, box: Rect) { return rect.every(Number.isFinite) && rect[0] < rect[2] && rect[1] < rect[3] && rect[0] >= box[0] - .5 && rect[1] >= box[1] - .5 && rect[2] <= box[2] + .5 && rect[3] <= box[3] + .5 }
export function textSelectionRange(selection: Selection, layer: HTMLElement): Range | null {
  if (!selection.rangeCount || selection.isCollapsed || (!layer.contains(selection.anchorNode) && !layer.contains(selection.focusNode))) return null
  const range = selection.getRangeAt(0).cloneRange(), bounds = document.createRange()
  bounds.selectNodeContents(layer)
  // 拖到页边或文字块外时只截取本页文字，避免整次选取被丢弃。
  if (range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) range.setStart(bounds.startContainer, bounds.startOffset)
  if (range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) range.setEnd(bounds.endContainer, bounds.endOffset)
  return range.collapsed ? null : range
}
export function selectionRects(range: Range, wrapper: HTMLElement, viewport: PageViewport, box: Rect): Rect[] {
  const origin = wrapper.getBoundingClientRect()
  const output: Rect[] = []
  // 按文字节点裁剪选区，避免父节点矩形覆盖双栏之间的空白。
  const walker = document.createTreeWalker(wrapper.querySelector('.textLayer')!, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (!range.intersectsNode(node) || !node.textContent) continue
    const local = document.createRange()
    local.setStart(node, node === range.startContainer ? range.startOffset : 0)
    local.setEnd(node, node === range.endContainer ? range.endOffset : node.textContent.length)
    for (const rect of Array.from(local.getClientRects())) {
      if (rect.width < .2 || rect.height < .2) continue
      const pdf = toPdfRect(viewport, [rect.left - origin.left, rect.top - origin.top, rect.right - origin.left, rect.bottom - origin.top])
      if (!validRect(pdf, box)) throw new Error('选区坐标无法可靠定位，请改用页码笔记。')
      if (!output.some(existing => existing.every((value, i) => Math.abs(value - pdf[i]) < .1))) output.push(pdf)
    }
  }
  if (!output.length || output.length > 200) throw new Error('选区过长或无法定位，请缩短选区后重试。')
  return output
}

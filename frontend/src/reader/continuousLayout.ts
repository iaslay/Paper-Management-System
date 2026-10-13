import type { PageSource, PositionValue } from './types'

export interface PageSize { width: number; height: number; rotation: number }
export interface PageLayout { page: number; top: number; width: number; height: number; scale: number }
export const pageGap = 16

export function sourceSize(source: PageSource): PageSize {
  return { width: (source.view_box[2] - source.view_box[0]) * source.user_unit, height: (source.view_box[3] - source.view_box[1]) * source.user_unit, rotation: source.intrinsic_rotation }
}

export function layoutPages(sizes: PageSize[], availableWidth: number, value: PositionValue): PageLayout[] {
  let top = 0
  return sizes.map((size, index) => {
    const sideways = ((size.rotation + value.view_rotation) % 180 + 180) % 180 !== 0
    const width = sideways ? size.height : size.width, height = sideways ? size.width : size.height
    const scale = value.zoom_mode === 'custom' ? value.zoom! : Math.max(.1, availableWidth / width)
    const item = { page: index + 1, top, width: width * scale, height: height * scale, scale }
    top += item.height + pageGap
    return item
  })
}

export function pageAt(layout: PageLayout[], position: number): PageLayout {
  // 二分查找使长论文的滚动定位不依赖逐页扫描。
  let low = 0, high = layout.length - 1
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2)
    if (layout[middle].top <= position) low = middle
    else high = middle - 1
  }
  return layout[low]
}

export function nearbyPages(layout: PageLayout[], top: number, height: number): number[] {
  const first = Math.max(1, pageAt(layout, top).page - 1)
  const last = Math.min(layout.length, pageAt(layout, top + height).page + 1)
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}

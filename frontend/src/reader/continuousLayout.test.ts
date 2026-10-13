import { expect, it } from 'vitest'
import { layoutPages, nearbyPages, pageAt, sourceSize } from './continuousLayout'
import type { PositionValue } from './types'

const fit: PositionValue = { page_number: 1, zoom_mode: 'fit_width', zoom: null, view_rotation: 0 }
it('混合尺寸页面连续衔接，每页按自己的比例适应宽度', () => {
  const pages = layoutPages([{ width: 400, height: 600, rotation: 0 }, { width: 800, height: 400, rotation: 0 }], 800, fit)
  expect(pages.map(page => [page.top, page.width, page.height])).toEqual([[0, 800, 1200], [1216, 800, 400]])
})
it('原始旋转、额外旋转、非零边界与用户单位正确合并', () => {
  const size = sourceSize({ id: '1', paper_id: '1', file_hash: 'hash', page_number: 1, view_box: [10, 20, 210, 420], intrinsic_rotation: 90, user_unit: 2 })
  expect(size).toEqual({ width: 400, height: 800, rotation: 90 })
  expect(layoutPages([size], 600, fit)[0].height).toBe(300)
  expect(layoutPages([size], 600, { ...fit, view_rotation: 90 })[0].height).toBe(1200)
})
it('自定义缩放保持实际尺寸及累积偏移，不依赖容器宽度', () => {
  const pages = layoutPages(Array(3).fill({ width: 400, height: 600, rotation: 0 }), 800, { ...fit, zoom_mode: 'custom', zoom: 1.5 })
  expect(pages[2]).toEqual({ page: 3, top: 1832, width: 600, height: 900, scale: 1.5 })
})
it('页间空隙归于上一页，首尾越界定位受到边界约束', () => {
  const pages = layoutPages(Array(3).fill({ width: 400, height: 600, rotation: 0 }), 400, fit)
  expect([-30, 599, 615, 616, 1232, 10000].map(top => pageAt(pages, top).page)).toEqual([1, 1, 1, 2, 3, 3])
})
it('百页论文只渲染可视范围及相邻页，兼顾小缩放下同时可见的多页', () => {
  const pages = layoutPages(Array(100).fill({ width: 400, height: 600, rotation: 0 }), 400, fit)
  expect(nearbyPages(pages, pages[49].top, 700)).toEqual([49, 50, 51, 52])
  expect(nearbyPages(pages, 0, 2500)).toEqual([1, 2, 3, 4, 5, 6])
})

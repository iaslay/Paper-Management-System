import { describe, expect, it } from 'vitest'
import type { PageViewport } from 'pdfjs-dist/types/src/display/page_viewport'
import { toPdfRect, toViewRect, validRect } from './geometry'
import type { Rect } from './types'

function viewport(scale: number, rotation: number) {
  const x0 = 20, y0 = 30, width = 500, height = 700
  function forward(x: number, y: number) {
    const u = (x - x0) * scale, v = (y0 + height - y) * scale
    return rotation === 90 ? [height * scale - v, u] : rotation === 180 ? [width * scale - u, height * scale - v] : rotation === 270 ? [v, width * scale - u] : [u, v]
  }
  function inverse(x: number, y: number) {
    const [u, v] = rotation === 90 ? [y, height * scale - x] : rotation === 180 ? [width * scale - x, height * scale - y] : rotation === 270 ? [width * scale - y, x] : [x, y]
    return [u / scale + x0, y0 + height - v / scale]
  }
  return { convertToViewportPoint: forward, convertToPdfPoint: inverse } as unknown as PageViewport
}
describe('高亮页面坐标', () => {
  for (const scale of [.5, 1, 2, 3]) for (const rotation of [0, 90, 180, 270]) it(`${scale} 倍与 ${rotation} 度旋转后可恢复非零页面坐标`, () => {
    const rect: Rect = [72, 100, 350, 125], view = viewport(scale, rotation)
    const restored = toPdfRect(view, toViewRect(view, rect))
    restored.forEach((value, i) => expect(value).toBeCloseTo(rect[i], 8))
  })
  it('非法矩形和明显越界被拒绝，保留页面原点', () => {
    const box: Rect = [20, 30, 520, 730]
    expect(validRect([20, 30, 100, 50], box)).toBe(true)
    expect(validRect([0, 0, 100, 50], box)).toBe(false)
    expect(validRect([30, 30, 20, 50], box)).toBe(false)
    expect(validRect([20, NaN, 100, 50], box)).toBe(false)
  })
})

import type { PDFDocumentProxy } from 'pdfjs-dist'

export type Rect = [number, number, number, number]
export type Color = 'yellow' | 'green' | 'blue' | 'pink'
export type NoteType = 'page_note' | 'annotation_comment' | 'personal_insight'
export type InsightKind = 'understanding' | 'question' | 'application'
export interface PositionValue { page_number: number; zoom_mode: 'fit_width' | 'custom'; zoom: number | null; view_rotation: number }
export interface Position extends PositionValue { paper_id: string; file_hash: string; revision: number; updated_at: number; last_opened_at: number }
export interface PageSource { id: string; paper_id: string; file_hash: string; page_number: number; view_box: Rect; intrinsic_rotation: number; user_unit: number }
export interface ReaderOpen { paper_id: string; file_hash: string; page_count: number; file_available: boolean; read_only: boolean; page_map_status: 'ready' | 'partial' | 'unavailable'; position: Position | null; page_sources: PageSource[] }
export interface Annotation { id: string; paper_id: string; file_hash: string; page_source_id: string; page_number: number; quote: string; rects: Rect[]; color: Color; revision: number; created_at: number; updated_at: number }
export interface Note { id: string; paper_id: string; file_hash: string; note_type: NoteType; content: string; page_number: number | null; annotation_id: string | null; insight_kind: InsightKind | null; revision: number; created_at: number; updated_at: number }
export interface NoteValue { content: string; page_number: number | null; insight_kind: InsightKind | null }
export interface NoteSeed extends NoteValue { note_type: NoteType; annotation_id: string | null }
export interface SelectionValue { quote: string; rects: Rect[]; page_number: number; page_source_id: string }
export interface AnnotationResult { annotation: Annotation; note: Note | null }
export interface PageList<T> { items: T[]; total: number; page: number; page_size: number }
export interface SaveControl { dirty: () => boolean; flush: () => Promise<boolean>; pause: () => void; text: () => string; subscribe: (listener: () => void) => () => void }
export interface ReaderHandle { flush: () => Promise<boolean>; dirty: () => boolean; text: () => string; retry: () => void }
export type RegisterSave = (key: string, control: SaveControl) => () => void
export interface ReaderDocument { pdf: PDFDocumentProxy; generation: number }
export const colors: Record<Color, string> = { yellow: '黄色', green: '绿色', blue: '蓝色', pink: '粉色' }
export const insightNames: Record<InsightKind, string> = { understanding: '我的理解', question: '待解决疑问', application: '可能用途' }

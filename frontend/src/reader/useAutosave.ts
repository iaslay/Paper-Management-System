import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { SaveQueue } from './saveQueue'
import type { RegisterSave } from './types'

export function useAutosave<T, R>({ value, remote, writer, validate, enabled, register, key, label, text, onSaved, autoCreate = false }: {
  value: T; remote: R | null; writer: (value: T, remote: R | null, requestId: string) => Promise<R>; validate: (value: T) => string | null;
  enabled: boolean; register: RegisterSave; key: string; label: string; text: (value: T) => string; onSaved?: (remote: R) => void; autoCreate?: boolean;
}) {
  const [queue] = useState(() => new SaveQueue(value, remote, writer, validate))
  queue.onSaved = onSaved
  const textCallback = useRef(text); textCallback.current = text
  const state = useSyncExternalStore(queue.subscribe, queue.snapshot)
  useEffect(() => { queue.setEnabled(enabled); if (autoCreate) queue.start(); return () => queue.pause() }, [queue, enabled, autoCreate])
  useEffect(() => register(key, { dirty: queue.dirty, flush: queue.flush, pause: queue.pause, subscribe: queue.subscribe, status: () => ({phase:queue.snapshot().phase,error:queue.snapshot().error}), text: () => `${label}\n${textCallback.current(queue.snapshot().draft)}` }), [queue, key, register, label])
  return { queue, state }
}

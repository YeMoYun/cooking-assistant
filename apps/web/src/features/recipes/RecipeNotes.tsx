import {
  recipeNoteSchema,
  type RecipeNote,
} from '@xiaochu/shared'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { apiClient } from '../../lib/api-client'

export type RecipeNotesProps = Readonly<{
  initialNotes: readonly RecipeNote[]
  recipeId: string
}>

type RequestState = 'error' | 'idle' | 'loading'

type DeletedNote = Readonly<{
  index: number
  note: RecipeNote
}>

type NoteItemProps = Readonly<{
  note: RecipeNote
  onDelete: (note: RecipeNote) => Promise<void>
  onSave: (note: RecipeNote, body: string) => Promise<void>
}>

const NoteItem = ({ note, onDelete, onSave }: NoteItemProps) => {
  const editorId = useId()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.body)
  const [state, setState] = useState<RequestState>('idle')

  useEffect(() => setDraft(note.body), [note.body])

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const body = draft.trim()
    if (body.length === 0 || state === 'loading') {
      return
    }
    setState('loading')
    try {
      await onSave(note, body)
      setState('idle')
      setEditing(false)
    } catch {
      setState('error')
    }
  }

  const remove = async (): Promise<void> => {
    setState('loading')
    try {
      await onDelete(note)
    } catch {
      setState('error')
    }
  }

  if (editing) {
    return (
      <li className="note-item note-item--editing">
        <form onSubmit={(event) => { void save(event) }}>
          <label htmlFor={editorId}>编辑笔记</label>
          <textarea
            aria-describedby={state === 'error' ? `${editorId}-error` : undefined}
            aria-invalid={state === 'error'}
            disabled={state === 'loading'}
            id={editorId}
            maxLength={10_000}
            onChange={(event) => setDraft(event.currentTarget.value)}
            required
            value={draft}
          />
          {state === 'error' && (
            <p id={`${editorId}-error`} role="alert">
              笔记没有保存，请检查本地服务后重试。
            </p>
          )}
          <div className="note-item__actions">
            <button
              disabled={state === 'loading' || draft.trim().length === 0}
              type="submit"
            >
              {state === 'loading' ? '正在保存' : '保存修改'}
            </button>
            <button
              className="text-button"
              disabled={state === 'loading'}
              onClick={() => {
                setDraft(note.body)
                setEditing(false)
                setState('idle')
              }}
              type="button"
            >
              取消
            </button>
          </div>
        </form>
      </li>
    )
  }

  return (
    <li className="note-item">
      <p>{note.body}</p>
      {state === 'error' && (
        <p className="note-item__error" role="alert">
          笔记没有删除，请检查本地服务后重试。
        </p>
      )}
      <div className="note-item__actions">
        <button
          className="text-button"
          disabled={state === 'loading'}
          onClick={() => setEditing(true)}
          type="button"
        >
          编辑
        </button>
        <button
          className="text-button text-button--danger"
          disabled={state === 'loading'}
          onClick={() => { void remove() }}
          type="button"
        >
          {state === 'loading' ? '正在删除' : '删除'}
        </button>
      </div>
    </li>
  )
}

export const RecipeNotes = ({ initialNotes, recipeId }: RecipeNotesProps) => {
  const newNoteId = useId()
  const [notes, setNotes] = useState<readonly RecipeNote[]>(initialNotes)
  const [newBody, setNewBody] = useState('')
  const [createState, setCreateState] = useState<RequestState>('idle')
  const [deletedNote, setDeletedNote] = useState<DeletedNote | undefined>()
  const [undoState, setUndoState] = useState<RequestState>('idle')
  const undoTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    setNotes(initialNotes)
    setNewBody('')
    setCreateState('idle')
    setDeletedNote(undefined)
    setUndoState('idle')
  }, [initialNotes, recipeId])

  useEffect(() => () => {
    if (undoTimer.current !== undefined) {
      window.clearTimeout(undoTimer.current)
    }
  }, [])

  const createNote = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const body = newBody.trim()
    if (body.length === 0 || createState === 'loading') {
      return
    }
    setCreateState('loading')
    try {
      const payload = await apiClient.request<unknown>('/api/notes', {
        body: { noteId: crypto.randomUUID(), recipeId, body },
        method: 'POST',
        signal: new AbortController().signal,
      })
      const note = recipeNoteSchema.parse(payload)
      setNotes((current) => [note, ...current])
      setNewBody('')
      setCreateState('idle')
    } catch {
      setCreateState('error')
    }
  }

  const saveNote = async (note: RecipeNote, body: string): Promise<void> => {
    const payload = await apiClient.request<unknown>(
      `/api/notes/${encodeURIComponent(note.id)}`,
      {
        body: { body },
        method: 'PATCH',
        signal: new AbortController().signal,
      },
    )
    const updated = recipeNoteSchema.parse(payload)
    setNotes((current) => current.map((item) => (
      item.id === updated.id ? updated : item
    )))
  }

  const deleteNote = async (note: RecipeNote): Promise<void> => {
    const index = notes.findIndex((item) => item.id === note.id)
    setNotes((current) => current.filter((item) => item.id !== note.id))
    try {
      await apiClient.request<void>(
        `/api/notes/${encodeURIComponent(note.id)}`,
        {
          method: 'DELETE',
          signal: new AbortController().signal,
        },
      )
      if (undoTimer.current !== undefined) {
        window.clearTimeout(undoTimer.current)
      }
      setDeletedNote({ index: Math.max(index, 0), note })
      setUndoState('idle')
      undoTimer.current = window.setTimeout(() => {
        setDeletedNote(undefined)
      }, 8_000)
    } catch (error) {
      setNotes((current) => {
        const next = [...current]
        next.splice(Math.max(index, 0), 0, note)
        return next
      })
      throw error
    }
  }

  const undoDelete = async (): Promise<void> => {
    if (deletedNote === undefined || undoState === 'loading') {
      return
    }
    setUndoState('loading')
    try {
      const payload = await apiClient.request<unknown>('/api/notes', {
        body: {
          noteId: deletedNote.note.id,
          recipeId,
          body: deletedNote.note.body,
        },
        method: 'POST',
        signal: new AbortController().signal,
      })
      const restored = recipeNoteSchema.parse(payload)
      setNotes((current) => {
        const next = [...current]
        next.splice(deletedNote.index, 0, restored)
        return next
      })
      setDeletedNote(undefined)
      setUndoState('idle')
      if (undoTimer.current !== undefined) {
        window.clearTimeout(undoTimer.current)
      }
    } catch {
      setUndoState('error')
    }
  }

  return (
    <section aria-labelledby="recipe-notes-title" className="detail-section recipe-notes">
      <header className="detail-section__heading">
        <div>
          <h2 id="recipe-notes-title">我的笔记</h2>
          <p>只保存在这台电脑上，不会改动原食谱。</p>
        </div>
      </header>

      <form className="new-note" onSubmit={(event) => { void createNote(event) }}>
        <label htmlFor={newNoteId}>记下这次要注意的事</label>
        <textarea
          aria-describedby={createState === 'error' ? `${newNoteId}-error` : undefined}
          aria-invalid={createState === 'error'}
          id={newNoteId}
          maxLength={10_000}
          onChange={(event) => setNewBody(event.currentTarget.value)}
          placeholder="例如：下次少放半勺盐"
          value={newBody}
        />
        {createState === 'error' && (
          <p id={`${newNoteId}-error`} role="alert">
            笔记没有保存，请检查本地服务后重试。
          </p>
        )}
        <button
          disabled={createState === 'loading' || newBody.trim().length === 0}
          type="submit"
        >
          {createState === 'loading' ? '正在保存' : '保存笔记'}
        </button>
      </form>

      {deletedNote !== undefined && (
        <div aria-live="polite" className="note-undo" role="status">
          <span>{undoState === 'error' ? '笔记已删除，但撤销失败。' : '笔记已删除。'}</span>
          <button
            disabled={undoState === 'loading'}
            onClick={() => { void undoDelete() }}
            type="button"
          >
            {undoState === 'loading' ? '正在撤销' : '撤销'}
          </button>
        </div>
      )}

      {notes.length === 0 ? (
        <p className="notes-empty">还没有笔记。做菜前后的调整都可以记在这里。</p>
      ) : (
        <ul className="notes-list">
          {notes.map((note) => (
            <NoteItem
              key={note.id}
              note={note}
              onDelete={deleteNote}
              onSave={saveNote}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

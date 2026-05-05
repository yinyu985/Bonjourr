import { eventDebounce } from '../utils/debounce.ts'
import { tradThis } from '../utils/translations.ts'

import type { Sync } from '../../types/sync.ts'

type NotesState = NonNullable<Sync['notes']>
type NoteRecord = NotesState['records'][number]

let noteState: NotesState = { active: '', records: [] }

export function notes(init: Sync): void {
    noteState = sanitizeNotes(init.notes)
    bindEvents()
    renderNotes()
}

function bindEvents(): void {
    const openButton = document.querySelector<HTMLButtonElement>('#show-notes button')
    const closeButton = document.getElementById('notes-close')
    const newButton = document.getElementById('notes-new')
    const titleInput = document.getElementById('notes-title') as HTMLInputElement | null
    const contentInput = document.getElementById('notes-content') as HTMLTextAreaElement | null

    openButton?.addEventListener('click', () => toggleNotes())
    closeButton?.addEventListener('click', () => toggleNotes(false))
    newButton?.addEventListener('click', createNote)
    titleInput?.addEventListener('input', () => {
        updateActiveNote({ title: titleInput.value.trimStart() || tradThis('Untitled note') })
    })
    contentInput?.addEventListener('input', () => {
        updateActiveNote({ content: contentInput.value })
    })

    document.addEventListener(
        'toggle-notes',
        ((event: CustomEvent) => {
            toggleNotes(event?.detail?.open)
        }) as EventListener,
    )
}

function toggleNotes(force?: boolean): void {
    const panel = document.getElementById('notes-panel')
    const trigger = document.getElementById('show-notes')
    const settings = document.getElementById('settings')
    const closeSettings = settings?.classList.contains('shown')
    const isOpen = panel?.classList.contains('shown') ?? false
    const shouldOpen = force ?? !isOpen

    if (closeSettings) {
        document.dispatchEvent(new CustomEvent('toggle-settings'))
    }

    panel?.classList.toggle('hidden', !shouldOpen)
    panel?.classList.toggle('shown', shouldOpen)
    trigger?.classList.toggle('shown', shouldOpen)

    if (shouldOpen && noteState.records.length === 0) {
        createNote()
    }
}

function createNote(): void {
    const id = `note-${Math.random().toString(36).slice(2, 10)}`
    const now = Date.now()

    noteState.records.unshift({
        id,
        title: tradThis('Untitled note'),
        content: '',
        updatedAt: now,
    })
    noteState.active = id

    persist()
    renderNotes()

    const titleInput = document.getElementById('notes-title') as HTMLInputElement | null
    titleInput?.focus()
    titleInput?.select()
}

function renameNote(noteId: string): void {
    const note = noteState.records.find((record) => record.id === noteId)

    if (!note) {
        return
    }

    const nextTitle = prompt(tradThis('Rename note'), note.title)?.trim()

    if (!nextTitle) {
        return
    }

    noteState.records = noteState.records.map((record) => {
        if (record.id !== noteId) {
            return record
        }

        return {
            ...record,
            title: nextTitle,
            updatedAt: Date.now(),
        }
    })

    persist()
    renderNotes(false)
}

function deleteNote(noteId: string): void {
    noteState.records = noteState.records.filter((note) => note.id !== noteId)
    noteState.active = noteState.records[0]?.id ?? ''

    persist()
    renderNotes()
}

function updateActiveNote(update: Partial<NoteRecord>): void {
    const activeId = noteState.active

    if (!activeId) {
        return
    }

    noteState.records = noteState.records.map((note) => {
        if (note.id !== activeId) {
            return note
        }

        return {
            ...note,
            ...update,
            updatedAt: Date.now(),
        }
    })

    persist()
    renderNotes(false)
}

function renderNotes(syncEditor = true): void {
    const list = document.getElementById('notes-items')
    const count = document.getElementById('notes-count')
    const title = document.getElementById('notes-title') as HTMLInputElement | null
    const content = document.getElementById('notes-content') as HTMLTextAreaElement | null
    const active = noteState.records.find((note) => note.id === noteState.active) ?? noteState.records[0]

    if (count) {
        count.textContent = noteState.records.length.toString()
    }

    if (active && noteState.active !== active.id) {
        noteState.active = active.id
    }

    if (list) {
        list.replaceChildren()

        for (const note of noteState.records) {
            const li = document.createElement('li')
            const row = document.createElement('div')
            const titleButton = document.createElement('button')
            const actionWrap = document.createElement('div')
            const renameButton = document.createElement('button')
            const deleteButton = document.createElement('button')

            row.className = 'notes-item-row'
            row.tabIndex = 0
            actionWrap.className = 'notes-item-actions'

            row.addEventListener('click', () => {
                noteState.active = note.id
                renderNotes()
            })
            row.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') {
                    return
                }

                event.preventDefault()
                noteState.active = note.id
                renderNotes()
            })

            titleButton.type = 'button'
            titleButton.textContent = note.title || tradThis('Untitled note')
            titleButton.className = 'notes-item-title'
            titleButton.classList.toggle('active', note.id === noteState.active)
            titleButton.tabIndex = -1
            titleButton.addEventListener('click', () => {
                noteState.active = note.id
                renderNotes()
            })

            renameButton.type = 'button'
            renameButton.className = 'notes-item-rename'
            renameButton.title = tradThis('Rename note')
            renameButton.setAttribute('aria-label', tradThis('Rename note'))
            renameButton.innerHTML =
                '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16.5V20h3.5L19 8.5 15.5 5 4 16.5zm17.7-10.3a1 1 0 0 0 0-1.4l-2.5-2.5a1 1 0 0 0-1.4 0l-1.9 1.9 3.5 3.5 2.3-2.3z"/></svg>'
            renameButton.addEventListener('click', (event) => {
                event.stopPropagation()
                renameNote(note.id)
            })

            deleteButton.type = 'button'
            deleteButton.className = 'notes-item-delete'
            deleteButton.title = tradThis('Delete note')
            deleteButton.setAttribute('aria-label', tradThis('Delete note'))
            deleteButton.innerHTML =
                '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12l-1 13H7L6 7zm3-3h6l1 2H8l1-2z"/></svg>'
            deleteButton.addEventListener('click', (event) => {
                event.stopPropagation()
                deleteNote(note.id)
            })

            actionWrap.appendChild(renameButton)
            actionWrap.appendChild(deleteButton)
            row.appendChild(titleButton)
            row.appendChild(actionWrap)
            li.appendChild(row)
            list.appendChild(li)
        }
    }

    if (syncEditor) {
        title && (title.value = active?.title ?? '')
        content && (content.value = active?.content ?? '')
    }
}

function persist(): void {
    eventDebounce({ notes: noteState })
}

function sanitizeNotes(notes: unknown): NotesState {
    const value: Partial<NotesState> = typeof notes === 'object' && notes ? notes as Partial<NotesState> : {}
    const records = Array.isArray(value.records) ? value.records : []

    return {
        active: typeof value.active === 'string' ? value.active : '',
        records: records
            .filter((record) => typeof record?.id === 'string')
            .map((record) => ({
                id: record.id,
                title: typeof record.title === 'string' ? record.title : tradThis('Untitled note'),
                content: typeof record.content === 'string' ? record.content : '',
                updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
            })),
    }
}

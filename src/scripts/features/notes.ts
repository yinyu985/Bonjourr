import { tradThis } from '../utils/translations.ts'
import { debounce } from '../utils/debounce.ts'
import { storage } from '../storage.ts'

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

    // Close notes panel when clicking outside the window
    document.getElementById('notes-panel')?.addEventListener('click', (event) => {
        if (event.target === document.getElementById('notes-panel')) {
            toggleNotes(false)
        }
    })
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

function deleteNote(noteId: string): void {
    noteState.records = noteState.records.filter((note) => note.id !== noteId)
    noteState.active = noteState.records[0]?.id ?? ''

    storage.sync.set({ notes: noteState })
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

let pendingPersist: Promise<void> = Promise.resolve()

const debouncedPersist = debounce(() => {
    pendingPersist = pendingPersist.then(async () => {
        await storage.sync.set({ notes: noteState })
    })
}, 300)

function persist(): void {
    debouncedPersist()
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

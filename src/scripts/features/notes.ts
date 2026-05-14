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
    const newButton = document.getElementById('notes-new')
    const contentInput = document.getElementById('notes-content') as HTMLTextAreaElement | null

    openButton?.addEventListener('click', () => toggleNotes())
    newButton?.addEventListener('click', createNote)

    const notesPanel = document.getElementById('notes-panel')

    // Close notes panel when clicking outside the window
    notesPanel?.addEventListener('click', (event) => {
        if (event.target === notesPanel) {
            toggleNotes(false)
        }
    })

    notesPanel?.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
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

    // Escape to close
    document.getElementById('notes-panel')?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            toggleNotes(false)
            return
        }

        if (event.key !== 'Tab') return

        const panel = document.getElementById('notes-window')
        if (!panel) return

        const focusable = panel.querySelectorAll<HTMLElement>(
            'button, input, textarea, [tabindex]:not([tabindex="-1"])',
        )
        const first = focusable[0]
        const last = focusable[focusable.length - 1]

        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
        }
    })
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
    panel?.toggleAttribute('inert', !shouldOpen)
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

    // Trigger inline rename on the newly created note
    const firstRow = document.querySelector<HTMLElement>('#notes-items .notes-item-row')
    const firstTitle = firstRow?.querySelector<HTMLSpanElement>('.notes-item-title')

    if (firstRow && firstTitle) {
        startInlineRename(firstRow, firstTitle, id)
    }
}

function deleteNote(noteId: string): void {
    noteState.records = noteState.records.filter((note) => note.id !== noteId)
    noteState.active = noteState.records[0]?.id ?? ''

    storage.sync.set({ notes: noteState })
    renderNotes()
}

function updateActiveNote(update: Partial<NoteRecord>): void {
    if (!noteState.active) {
        return
    }

    updateNote(noteState.active, update)
    renderNotes(false)
}

function updateNote(noteId: string, update: Partial<NoteRecord>): void {
    noteState.records = noteState.records.map((note) => {
        if (note.id !== noteId) {
            return note
        }

        return {
            ...note,
            ...update,
            updatedAt: Date.now(),
        }
    })

    persist()
}

function selectNote(noteId: string): void {
    if (noteState.active === noteId) {
        return
    }

    noteState.active = noteId

    for (const row of document.querySelectorAll<HTMLElement>('#notes-items .notes-item-row')) {
        row.classList.toggle('active', row.dataset.noteId === noteId)
    }

    const content = document.getElementById('notes-content') as HTMLTextAreaElement | null
    const active = noteState.records.find((note) => note.id === noteId)

    if (content) {
        content.value = active?.content ?? ''
    }
}

function renderNotes(syncEditor = true): void {
    const list = document.getElementById('notes-items')
    const content = document.getElementById('notes-content') as HTMLTextAreaElement | null
    const active = noteState.records.find((note) => note.id === noteState.active) ?? noteState.records[0]

    if (active && noteState.active !== active.id) {
        noteState.active = active.id
    }

    if (list) {
        list.replaceChildren()

        for (const note of noteState.records) {
            const li = document.createElement('li')
            const row = document.createElement('div')
            const titleSpan = document.createElement('span')
            const deleteButton = document.createElement('button')
            const isActive = note.id === noteState.active

            row.className = 'notes-item-row'
            row.classList.toggle('active', isActive)
            row.dataset.noteId = note.id
            row.tabIndex = 0

            row.addEventListener('click', () => {
                selectNote(note.id)
            })
            row.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') {
                    return
                }
                event.preventDefault()
                selectNote(note.id)
            })

            titleSpan.textContent = note.title || tradThis('Untitled note')
            titleSpan.className = 'notes-item-title'
            titleSpan.addEventListener('dblclick', (event) => {
                event.preventDefault()
                event.stopPropagation()
                selectNote(note.id)
                startInlineRename(row, titleSpan, note.id)
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

            row.appendChild(titleSpan)
            row.appendChild(deleteButton)
            li.appendChild(row)
            list.appendChild(li)
        }
    }

    if (syncEditor) {
        content && (content.value = active?.content ?? '')
    }
}

function startInlineRename(_row: HTMLElement, titleSpan: HTMLSpanElement, noteId: string): void {
    const note = noteState.records.find((n) => n.id === noteId)

    if (!note) {
        return
    }

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'notes-item-title-edit'
    input.value = note.title || ''
    input.maxLength = 120
    input.setAttribute('aria-label', tradThis('Rename note'))

    titleSpan.replaceWith(input)
    input.focus()
    input.select()

    function commitRename(): void {
        const newTitle = input.value.trim() || tradThis('Untitled note')
        updateNote(noteId, { title: newTitle })
        noteState.active = noteId
        renderNotes()
    }

    input.addEventListener('blur', commitRename)
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault()
            input.blur()
        }
        if (event.key === 'Escape') {
            event.preventDefault()
            input.removeEventListener('blur', commitRename)
            renderNotes()
        }
    })
    input.addEventListener('click', (event) => event.stopPropagation())
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

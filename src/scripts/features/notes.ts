import { updateSettingsJson } from '../settings.ts'
import { getLang, tradThis } from '../utils/translations.ts'
import { debounce } from '../utils/debounce.ts'
import { storage } from '../storage.ts'

import type { Sync } from '../../types/sync.ts'

type NotesState = NonNullable<Sync['notes']>
type NoteRecord = NotesState['records'][number]

let noteState: NotesState = { active: '', records: [] }
let eventsBound = false

export function notes(init: Sync): void {
    noteState = sanitizeNotes(init.notes)

    if (!eventsBound) {
        eventsBound = true
        bindEvents()
    }
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

    if (!shouldOpen) {
        persist(true)
    }
}

function createNote(): void {
    const id = `note-${Math.random().toString(36).slice(2, 10)}`

    noteState.records.unshift({
        id,
        title: tradThis('Untitled note'),
        content: '',
        updatedAt: new Date().toISOString(),
    })
    noteState.active = id

    persist(true)
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

    applyNoteUpdate(noteState.active, update)
    persist()
    renderNotes(false)
}

function updateNote(noteId: string, update: Partial<NoteRecord>): void {
    applyNoteUpdate(noteId, update)
    persist(true)
}

function applyNoteUpdate(noteId: string, update: Partial<NoteRecord>): void {
    noteState.records = noteState.records.map((note) => {
        if (note.id !== noteId) {
            return note
        }

        return {
            ...note,
            ...update,
            updatedAt: new Date().toISOString(),
        }
    })
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

    renderNoteTimestamp(active)
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
                if ((event.target as HTMLElement).tagName === 'INPUT') {
                    return
                }
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

    renderNoteTimestamp(active)
}

function startInlineRename(_row: HTMLElement, titleSpan: HTMLSpanElement, noteId: string): void {
    const note = noteState.records.find((n) => n.id === noteId)

    if (!note) {
        return
    }

    titleSpan.contentEditable = 'true'
    titleSpan.textContent = note.title || ''
    titleSpan.focus()

    const range = document.createRange()
    range.selectNodeContents(titleSpan)
    const sel = globalThis.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)

    function commitRename(): void {
        titleSpan.contentEditable = 'false'
        const newTitle = titleSpan.textContent?.trim() || tradThis('Untitled note')
        updateNote(noteId, { title: newTitle })
        noteState.active = noteId
        renderNotes()
    }

    titleSpan.addEventListener('blur', commitRename, { once: true })
    function handleKeydown(event: KeyboardEvent): void {
        if (event.key === 'Enter') {
            event.preventDefault()
            titleSpan.blur()
        }
        if (event.key === 'Escape') {
            event.preventDefault()
            titleSpan.removeEventListener('blur', commitRename)
            titleSpan.removeEventListener('keydown', handleKeydown)
            titleSpan.contentEditable = 'false'
            renderNotes()
        }
    }

    titleSpan.addEventListener('keydown', handleKeydown)
}

let pendingPersist: Promise<void> = Promise.resolve()

const debouncedPersist = debounce(() => {
    pendingPersist = pendingPersist.then(async () => {
        await storage.sync.set({ notes: noteState })
    })
}, 300)

function persist(immediate = false): void {
    if (immediate) {
        pendingPersist = pendingPersist.then(async () => {
            await storage.sync.set({ notes: noteState })
            updateSettingsJson()
        })
    } else {
        debouncedPersist()
    }
}

function renderNoteTimestamp(note?: NoteRecord): void {
    const editor = document.getElementById('notes-editor')
    let el = document.getElementById('notes-timestamp')

    if (!note?.updatedAt) {
        el?.remove()
        return
    }

    if (!el) {
        el = document.createElement('span')
        el.id = 'notes-timestamp'
        editor?.appendChild(el)
    }

    const date = new Date(note.updatedAt)
    el.textContent = date.toLocaleString(getLang(), {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    })
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
                updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
            })),
    }
}

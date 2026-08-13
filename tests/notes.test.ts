import './init.test.ts'

import { assertEquals, assertStrictEquals } from '@std/assert'
import { notes } from '../src/scripts/features/notes.ts'
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import { flushPendingDebounces } from '../src/scripts/utils/debounce.ts'

Deno.test('typing in a note preserves the rendered note list', async () => {
    document.body.insertAdjacentHTML(
        'beforeend',
        `
            <div id="show-notes"><button></button></div>
            <button id="notes-new"></button>
            <section id="notes-panel">
                <div id="notes-window">
                    <ul id="notes-items"></ul>
                    <section id="notes-editor"><textarea id="notes-content"></textarea></section>
                </div>
            </section>
        `,
    )

    const sync = structuredClone(SYNC_DEFAULT)
    sync.notes = {
        active: 'note-one',
        records: [{ id: 'note-one', title: 'One', content: '', updatedAt: new Date(0).toISOString() }],
    }
    notes(sync)

    const rowBefore = document.querySelector('#notes-items .notes-item-row')
    const input = document.getElementById('notes-content') as HTMLTextAreaElement
    input.value = 'typed content'
    input.dispatchEvent(new Event('input'))

    assertStrictEquals(document.querySelector('#notes-items .notes-item-row'), rowBefore)
    await flushPendingDebounces()

    document.getElementById('notes-new')?.click()
    let timeout = 0
    try {
        await Promise.race([
            flushPendingDebounces(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error('notes persistence deadlocked')), 500)
            }),
        ])
    } finally {
        clearTimeout(timeout)
    }
    assertEquals(document.querySelectorAll('#notes-items .notes-item-row').length, 2)

    document.getElementById('show-notes')?.remove()
    document.getElementById('notes-new')?.remove()
    document.getElementById('notes-panel')?.remove()
})

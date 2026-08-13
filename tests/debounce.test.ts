import './init.test.ts'

import { assertEquals, assertRejects } from '@std/assert'
import {
    cancelPendingDebounces,
    debounce,
    eventDebounce,
    flushPendingDebounces,
} from '../src/scripts/utils/debounce.ts'
import { storage } from '../src/scripts/storage.ts'

Deno.test({
    name: 'eventDebounce merges unrelated setting patches',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        storage.type.set('localstorage')
        localStorage.removeItem('bonjourr')

        eventDebounce({ tabtitle: 'merged title' })
        eventDebounce({ textShadow: 0.75 })
        await flushPendingDebounces()

        const sync = await storage.sync.get()
        assertEquals(sync.tabtitle, 'merged title')
        assertEquals(sync.textShadow, 0.75)
    },
})

Deno.test({
    name: 'flushPendingDebounces waits for asynchronous callbacks',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        let completed = false
        const save = debounce(
            async () => {
                await Promise.resolve()
                completed = true
            },
            10_000,
            { barrier: true },
        )

        save()
        assertEquals(completed, false)
        await flushPendingDebounces()
        assertEquals(completed, true)
    },
})

Deno.test({
    name: 'cancelPendingDebounces prevents scheduled callbacks',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        let calls = 0
        const save = debounce(
            () => {
                calls += 1
            },
            10_000,
            { barrier: true },
        )

        save()
        cancelPendingDebounces()
        await flushPendingDebounces()

        assertEquals(calls, 0)
        assertEquals(save.pending(), false)
    },
})

Deno.test({
    name: 'flushPendingDebounces rejects callback failures',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const save = debounce(
            () => {
                throw new Error('cannot save')
            },
            10_000,
            { barrier: true },
        )

        save()
        await assertRejects(() => flushPendingDebounces(), AggregateError)
    },
})

import './init.test.ts'

import { assertEquals } from '@std/assert'
import { isStorageDefault, storage } from '../src/scripts/storage.ts'
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'

Deno.test({
    name: 'storage.init returns valid sync and local objects',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const { sync, local } = await storage.init()

        assertEquals(typeof sync.lang, 'string')
        assertEquals(typeof sync.time, 'boolean')
        assertEquals(typeof sync.links.enabled, 'boolean')
        assertEquals(Array.isArray(sync.links.folders), true)
        assertEquals(typeof local.syncType, 'string')
    },
})

Deno.test({
    name: 'storage type defaults to localstorage when chrome.storage is absent',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const type = storage.type.init()
        assertEquals(type, 'localstorage')
    },
})

Deno.test({
    name: 'syncGet returns defaults when localstorage is empty',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        localStorage.removeItem('bonjourr')
        const sync = await storage.sync.get()

        assertEquals(sync.time, SYNC_DEFAULT.time)
        assertEquals(sync.lang, SYNC_DEFAULT.lang)
    },
})

Deno.test({
    name: 'syncSet persists data that syncGet can retrieve',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        localStorage.removeItem('bonjourr')

        await storage.sync.set({ lang: 'fr', time: false })
        const sync = await storage.sync.get()

        assertEquals(sync.lang, 'fr')
        assertEquals(sync.time, false)
    },
})

Deno.test({
    name: 'syncRemove deletes a key from storage',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        localStorage.removeItem('bonjourr')

        await storage.sync.set({ tabtitle: 'Hello' })
        await storage.sync.remove('tabtitle')
        const sync = await storage.sync.get()

        assertEquals(sync.tabtitle, SYNC_DEFAULT.tabtitle)
    },
})

Deno.test({
    name: 'syncClear removes all sync data',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await storage.sync.set({ lang: 'de' })
        await storage.sync.clear()
        const sync = await storage.sync.get()

        assertEquals(sync.lang, SYNC_DEFAULT.lang)
    },
})

Deno.test({
    name: 'localSet and localGet round-trip for JSON values',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        storage.local.set({ backgroundLastChange: '2024-01-01' })
        const local = await storage.local.get('backgroundLastChange')

        assertEquals(local.backgroundLastChange, '2024-01-01')
    },
})

Deno.test({
    name: 'localRemove deletes a local key',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        storage.local.set({ backgroundLastChange: '2024-06-01' })
        await storage.local.remove('backgroundLastChange')
        const local = await storage.local.get('backgroundLastChange')

        assertEquals(local.backgroundLastChange, '')
    },
})

Deno.test({
    name: 'isStorageDefault returns true for untouched defaults',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const data = structuredClone(SYNC_DEFAULT)
        assertEquals(isStorageDefault(data), true)
    },
})

Deno.test({
    name: 'isStorageDefault returns false when data differs',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const data = structuredClone(SYNC_DEFAULT)
        data.lang = 'fr'
        assertEquals(isStorageDefault(data), false)
    },
})


Deno.test({
    name: 'verifyDataAsSync fills missing fields from defaults',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        localStorage.removeItem('bonjourr')
        localStorage.bonjourr = JSON.stringify({ lang: 'ja' })

        const sync = await storage.sync.get()

        assertEquals(sync.lang, 'ja')
        assertEquals(sync.time, SYNC_DEFAULT.time)
        assertEquals(sync.clock.seconds, SYNC_DEFAULT.clock.seconds)
    },
})

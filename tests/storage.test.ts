import './init.test.ts'

import { assertEquals, assertRejects } from '@std/assert'
import { isStorageDefault, storage } from '../src/scripts/storage.ts'
import { LOCAL_DEFAULT, SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import type { Sync } from '../src/types/sync.ts'

interface WebextStorageMock {
    area: typeof chrome.storage.local
    requestedKeys: (string | string[] | undefined)[]
    state: Record<string, unknown>
}

interface IndexedDbArchiveMock {
    state: Map<string, unknown>
    restore: () => void
}

function installWebextStorage(mock: WebextStorageMock): () => void {
    const previous = globalThis.chrome
    Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        writable: true,
        value: {
            ...previous,
            storage: { local: mock.area },
        } as typeof chrome,
    })
    storage.type.set('webext-local')

    return () => {
        Object.defineProperty(globalThis, 'chrome', {
            configurable: true,
            writable: true,
            value: previous,
        })
        storage.type.set('localstorage')
    }
}

function webextStorageMock(
    initial: Record<string, unknown>,
    fail?: 'get' | 'set' | 'remove' | 'clear',
): WebextStorageMock {
    const state = structuredClone(initial)
    const requestedKeys: (string | string[] | undefined)[] = []
    const failure = (): Error => new Error(`mock ${fail} failure`)
    const area = {
        get(keys?: string | string[]): Promise<Record<string, unknown>> {
            requestedKeys.push(keys)
            if (fail === 'get') return Promise.reject(failure())
            if (typeof keys === 'string') {
                return Promise.resolve(keys in state ? { [keys]: structuredClone(state[keys]) } : {})
            }
            if (Array.isArray(keys)) {
                return Promise.resolve(
                    Object.fromEntries(
                        keys.filter((key) => key in state).map((key) => [key, structuredClone(state[key])]),
                    ),
                )
            }
            return Promise.resolve(structuredClone(state))
        },
        set(value: Record<string, unknown>): Promise<void> {
            if (fail === 'set') return Promise.reject(failure())
            Object.assign(state, structuredClone(value))
            return Promise.resolve()
        },
        remove(keys: string | string[]): Promise<void> {
            if (fail === 'remove') return Promise.reject(failure())
            for (const key of typeof keys === 'string' ? [keys] : keys) delete state[key]
            return Promise.resolve()
        },
        clear(): Promise<void> {
            if (fail === 'clear') return Promise.reject(failure())
            for (const key of Object.keys(state)) delete state[key]
            return Promise.resolve()
        },
    } as unknown as typeof chrome.storage.local

    return { area, requestedKeys, state }
}

function installIndexedDbArchiveMock(): IndexedDbArchiveMock {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
    const state = new Map<string, unknown>()
    let storeCreated = false

    const database = {
        onversionchange: null,
        objectStoreNames: {
            contains: (name: string): boolean => storeCreated && name === 'archives',
        },
        createObjectStore: (): IDBObjectStore => {
            storeCreated = true
            return {} as IDBObjectStore
        },
        transaction: (): IDBTransaction => {
            const transaction = {
                oncomplete: null,
                onerror: null,
                onabort: null,
                objectStore: () => objectStore,
            } as unknown as IDBTransaction
            const finish = (): void => {
                queueMicrotask(() => transaction.oncomplete?.call(transaction, new Event('complete')))
            }
            const objectStore = {
                get(key: IDBValidKey): IDBRequest<unknown> {
                    const request = { onsuccess: null, onerror: null } as unknown as IDBRequest<unknown>
                    queueMicrotask(() => {
                        Object.defineProperty(request, 'result', {
                            configurable: true,
                            value: state.has(String(key)) ? structuredClone(state.get(String(key))) : undefined,
                        })
                        request.onsuccess?.call(request, new Event('success'))
                        finish()
                    })
                    return request
                },
                put(value: unknown, key: IDBValidKey): IDBRequest<IDBValidKey> {
                    const request = {} as IDBRequest<IDBValidKey>
                    queueMicrotask(() => {
                        state.set(String(key), structuredClone(value))
                        finish()
                    })
                    return request
                },
                delete(key: IDBValidKey): IDBRequest<undefined> {
                    const request = {} as IDBRequest<undefined>
                    queueMicrotask(() => {
                        state.delete(String(key))
                        finish()
                    })
                    return request
                },
            } as IDBObjectStore

            return transaction
        },
        close: (): void => {},
    } as unknown as IDBDatabase

    const factory = {
        open: (): IDBOpenDBRequest => {
            const request = {
                onupgradeneeded: null,
                onsuccess: null,
                onerror: null,
                onblocked: null,
            } as unknown as IDBOpenDBRequest
            Object.defineProperty(request, 'result', { configurable: true, value: database })
            queueMicrotask(() => {
                request.onupgradeneeded?.call(request, new Event('upgradeneeded') as IDBVersionChangeEvent)
                request.onsuccess?.call(request, new Event('success'))
            })
            return request
        },
    } as unknown as IDBFactory

    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory })

    return {
        state,
        restore: () => {
            database.onversionchange?.call(database, new Event('versionchange') as IDBVersionChangeEvent)
            if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor)
            else Reflect.deleteProperty(globalThis, 'indexedDB')
        },
    }
}

Deno.test({
    name: 'storage.init returns valid sync and local objects',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const { sync, local } = await storage.init()

        assertEquals(typeof sync.lang, 'string')
        assertEquals(typeof sync.time, 'boolean')
        assertEquals(typeof sync.links.enabled, 'boolean')
        assertEquals('folders' in sync.links, false)
        assertEquals(typeof local.syncType, 'string')
    },
})

Deno.test({
    name: 'webext syncGet requests only syncStorage',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const mock = webextStorageMock({ syncStorage: { ...SYNC_DEFAULT, lang: 'fr' }, unrelated: 'large cache' })
        const restore = installWebextStorage(mock)

        try {
            const sync = await storage.sync.get('lang')
            assertEquals(sync.lang, 'fr')
            assertEquals(mock.requestedKeys, ['syncStorage'])
        } finally {
            restore()
        }
    },
})

Deno.test({
    name: 'webext init refreshes stale injected config through authoritative storage',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const authoritative = { ...structuredClone(SYNC_DEFAULT), lang: 'ja' }
        const stale = { ...structuredClone(SYNC_DEFAULT), lang: 'fr' }
        const mock = webextStorageMock({ syncStorage: authoritative })
        const restore = installWebextStorage(mock)
        const previousStartupStorage = globalThis.startupStorage
        globalThis.startupStorage = {
            sync: stale,
            local: { ...structuredClone(LOCAL_DEFAULT), syncStorage: stale },
        }

        try {
            const initialized = await storage.init()
            assertEquals(initialized.sync.lang, 'ja')
            assertEquals(initialized.local.syncStorage?.lang, 'ja')
        } finally {
            globalThis.startupStorage = previousStartupStorage
            restore()
        }
    },
})

Deno.test({
    name: 'syncReplace atomically persists a sanitized snapshot without dirty event',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const mock = webextStorageMock({})
        const restore = installWebextStorage(mock)
        let dirtyEvents = 0
        const countDirty = (): void => {
            dirtyEvents += 1
        }
        globalThis.addEventListener('bonjourr-sync-write', countDirty)

        try {
            const replacement = structuredClone(SYNC_DEFAULT) as typeof SYNC_DEFAULT & {
                links: typeof SYNC_DEFAULT.links & {
                    folders?: unknown
                    favorites?: unknown
                    toolbarOrder?: unknown
                }
            }
            replacement.lang = 'ja'
            replacement.links.folders = [{ id: 'folder', title: 'Folder', items: [] }]
            replacement.links.favorites = [{ id: 'bookmark', title: 'Bookmark', url: 'https://example.com' }]
            replacement.links.toolbarOrder = ['folder', 'bookmark']

            await storage.sync.replace(replacement)

            const stored = mock.state.syncStorage as typeof replacement
            assertEquals(stored.lang, 'ja')
            assertEquals('folders' in stored.links, false)
            assertEquals('favorites' in stored.links, false)
            assertEquals('toolbarOrder' in stored.links, false)
            assertEquals(dirtyEvents, 0)
        } finally {
            globalThis.removeEventListener('bonjourr-sync-write', countDirty)
            restore()
        }
    },
})

Deno.test({
    name: 'storage mutations reject webext API failures',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        for (const operation of ['sync-set', 'sync-remove', 'sync-clear', 'local-set', 'local-remove', 'local-clear']) {
            const fail = operation === 'sync-set' || operation === 'sync-remove' || operation === 'local-set'
                ? 'set'
                : 'remove'
            const mock = webextStorageMock({
                syncStorage: structuredClone(SYNC_DEFAULT),
                backgroundLastChange: 'today',
            }, fail)
            const restore = installWebextStorage(mock)

            try {
                if (operation === 'sync-set') await assertRejects(() => storage.sync.set({ lang: 'fr' }))
                if (operation === 'sync-remove') await assertRejects(() => storage.sync.remove('lang'))
                if (operation === 'sync-clear') await assertRejects(() => storage.sync.clear())
                if (operation === 'local-set') {
                    await assertRejects(() => storage.local.set({ backgroundLastChange: 'today' }))
                }
                if (operation === 'local-remove') {
                    await assertRejects(() => storage.local.remove('backgroundLastChange'))
                }
                if (operation === 'local-clear') await assertRejects(() => storage.local.clear())
            } finally {
                restore()
            }
        }
    },
})

Deno.test({
    name: 'syncReplace rejects when readback does not match',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const mock = webextStorageMock({ syncStorage: structuredClone(SYNC_DEFAULT) })
        mock.area.set = () => Promise.resolve()
        const restore = installWebextStorage(mock)
        const replacement = structuredClone(SYNC_DEFAULT)
        replacement.lang = 'fr'

        try {
            await assertRejects(() => storage.sync.replace(replacement), Error, 'verification failed')
        } finally {
            restore()
        }
    },
})

Deno.test({
    name: 'syncReplace replaces localStorage in one complete snapshot',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        storage.type.set('localstorage')
        await storage.sync.set({ tabtitle: 'obsolete', css: 'old' })
        const replacement = structuredClone(SYNC_DEFAULT)
        replacement.lang = 'zh-CN'

        await storage.sync.replace(replacement)

        const persisted = JSON.parse(localStorage.bonjourr)
        assertEquals(persisted.lang, 'zh-CN')
        assertEquals(persisted.tabtitle, SYNC_DEFAULT.tabtitle)
        assertEquals(persisted.css, SYNC_DEFAULT.css)
    },
})

Deno.test({
    name: 'syncUpdate serializes read-modify-write operations without losing fields',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        storage.type.set('localstorage')
        await storage.sync.replace(structuredClone(SYNC_DEFAULT))

        await Promise.all([
            storage.sync.update((data) => {
                data.links.enabled = false
            }),
            storage.sync.update((data) => {
                data.links.rows = 9
            }),
        ])

        const saved = await storage.sync.get()
        assertEquals(saved.links.enabled, false)
        assertEquals(saved.links.rows, 9)
    },
})

Deno.test({
    name: 'exclusive storage mutation blocks outside reads and queued writes',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        storage.type.set('localstorage')
        await storage.sync.replace(structuredClone(SYNC_DEFAULT))
        let releaseMutation: () => void = () => {}
        const mutationGate = new Promise<void>((resolve) => {
            releaseMutation = resolve
        })

        const exclusive = storage.runExclusive(async (syncAccess) => {
            const data = await syncAccess.get()
            data.lang = 'ja'
            await mutationGate
            await syncAccess.replace(data)
        })
        await new Promise((resolve) => setTimeout(resolve, 0))

        let readFinished = false
        const outsideRead = storage.sync.get().then((data) => {
            readFinished = true
            return data
        })
        const outsideWrite = storage.sync.update((data) => {
            data.tabtitle = 'after-exclusive'
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
        assertEquals(readFinished, false)

        releaseMutation()
        await exclusive
        const read = await outsideRead
        await outsideWrite
        const final = await storage.sync.get()
        assertEquals(read.lang, 'ja')
        assertEquals(final.lang, 'ja')
        assertEquals(final.tabtitle, 'after-exclusive')
    },
})

Deno.test({
    name: 'webext localClear preserves syncStorage while removing local state',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const syncStorage = { ...structuredClone(SYNC_DEFAULT), lang: 'ko' }
        const mock = webextStorageMock({
            syncStorage,
            'bonjourr-archive-config-snapshots': [{ safe: true }],
            backgroundLastChange: 'today',
            fonts: [{ family: 'Example' }],
        })
        const restore = installWebextStorage(mock)

        try {
            await storage.local.clear()
            assertEquals(mock.state, {
                syncStorage,
                'bonjourr-archive-config-snapshots': [{ safe: true }],
            })
        } finally {
            restore()
        }
    },
})

Deno.test({
    name: 'webext archives migrate from localStorage and persist in isolated extension keys',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const key = 'bonjourr-archive-config-snapshots'
        const legacy = [{ timestamp: 'old', reason: 'legacy' }]
        const replacement = [{ timestamp: 'new', reason: 'webext' }]
        const mock = webextStorageMock({ syncStorage: structuredClone(SYNC_DEFAULT) })
        const restore = installWebextStorage(mock)
        localStorage.setItem(key, JSON.stringify(legacy))

        try {
            assertEquals(await storage.archive.get(key), legacy)
            assertEquals(mock.state[key], legacy)
            assertEquals(localStorage.getItem(key), null)

            await storage.archive.set(key, replacement)
            assertEquals(await storage.archive.get(key), replacement)
            assertEquals(mock.state[key], replacement)
        } finally {
            localStorage.removeItem(key)
            restore()
        }
    },
})

Deno.test({
    name: 'online archives migrate from localStorage into IndexedDB',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const key = 'bonjourr-archive-indexeddb-test'
        const legacy = [{ timestamp: 'old', reason: 'legacy' }]
        const replacement = [{ timestamp: 'new', reason: 'indexeddb' }]
        const indexedDb = installIndexedDbArchiveMock()
        storage.type.set('localstorage')
        localStorage.setItem(key, JSON.stringify(legacy))

        try {
            assertEquals(await storage.archive.get(key), legacy)
            assertEquals(indexedDb.state.get(key), legacy)
            assertEquals(localStorage.getItem(key), null)

            await storage.archive.set(key, replacement)
            assertEquals(await storage.archive.get(key), replacement)
            await storage.archive.remove(key)
            assertEquals(await storage.archive.get(key), undefined)
        } finally {
            localStorage.removeItem(key)
            indexedDb.restore()
        }
    },
})

Deno.test({
    name: 'clearall preserves local background blobs and recovery archives',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        storage.type.set('localstorage')
        let cacheDeletes = 0
        const cachesDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches')
        Object.defineProperty(globalThis, 'caches', {
            configurable: true,
            value: {
                delete: (): Promise<boolean> => {
                    cacheDeletes += 1
                    return Promise.resolve(true)
                },
            },
        })
        localStorage.setItem('bonjourr-archive-config-snapshots', 'recoverable')
        localStorage.setItem('temporary-setting', 'remove me')

        try {
            await storage.clearall()
            assertEquals(cacheDeletes, 0)
            assertEquals(localStorage.getItem('bonjourr-archive-config-snapshots'), 'recoverable')
            assertEquals(localStorage.getItem('temporary-setting'), null)
        } finally {
            localStorage.removeItem('bonjourr-archive-config-snapshots')
            if (cachesDescriptor) {
                Object.defineProperty(globalThis, 'caches', cachesDescriptor)
            } else {
                Reflect.deleteProperty(globalThis, 'caches')
            }
        }
    },
})

Deno.test({
    name: 'reset preserves recovery archives and clears volatile settings',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const mock = webextStorageMock({
            syncStorage: { ...structuredClone(SYNC_DEFAULT), lang: 'fr' },
            backgroundLastChange: 'today',
            'bonjourr-archive-config-snapshots': [{ safe: true }],
        })
        const restore = installWebextStorage(mock)
        localStorage.setItem('bonjourr-archive-config-snapshots', '[{"safe":true}]')
        localStorage.setItem('backgroundCache', 'temporary')

        try {
            await storage.clearall()
            assertEquals(mock.state.backgroundLastChange, '')
            assertEquals(mock.state['bonjourr-archive-config-snapshots'], [{ safe: true }])
            assertEquals((mock.state.syncStorage as typeof SYNC_DEFAULT).lang, SYNC_DEFAULT.lang)
            assertEquals(localStorage.getItem('bonjourr-archive-config-snapshots'), '[{"safe":true}]')
            assertEquals(localStorage.getItem('backgroundCache'), null)
        } finally {
            localStorage.removeItem('bonjourr-archive-config-snapshots')
            restore()
        }
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
    name: 'storage defaults are cloned instead of shared with callers',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        localStorage.removeItem('bonjourr')
        const sync = await storage.sync.get()
        sync.links.rows = 999

        const next = await storage.sync.get()
        assertEquals(next.links.rows, SYNC_DEFAULT.links.rows)
    },
})

Deno.test({
    name: 'corrupted persisted branches fall back independently without discarding valid settings',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        storage.type.set('localstorage')
        localStorage.bonjourr = JSON.stringify({
            ...structuredClone(SYNC_DEFAULT),
            lang: 'fr',
            links: { ...SYNC_DEFAULT.links, enabled: 'not-a-boolean' },
            clock: { ampm: true },
        })

        try {
            const sync = await storage.sync.get()
            assertEquals(sync.lang, 'fr')
            assertEquals(sync.links, SYNC_DEFAULT.links)
            assertEquals(sync.clock.ampm, true)
            assertEquals(sync.clock.seconds, SYNC_DEFAULT.clock.seconds)
            assertEquals(sync.clock.size, SYNC_DEFAULT.clock.size)
        } finally {
            localStorage.removeItem('bonjourr')
        }
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
    name: 'syncSet deep-merges nested patches instead of resetting sibling settings',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        localStorage.bonjourr = JSON.stringify({
            ...structuredClone(SYNC_DEFAULT),
            links: { ...SYNC_DEFAULT.links, rows: 24, newTab: false },
        })

        try {
            await storage.sync.set({ links: { enabled: false } } as Partial<Sync>)
            const sync = await storage.sync.get()
            assertEquals(sync.links.enabled, false)
            assertEquals(sync.links.rows, 24)
            assertEquals(sync.links.newTab, false)
        } finally {
            localStorage.removeItem('bonjourr')
        }
    },
})

Deno.test({
    name: 'invalid writes reject without replacing the previously persisted branch',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        storage.type.set('localstorage')
        const initial = structuredClone(SYNC_DEFAULT)
        initial.links.rows = 24
        localStorage.bonjourr = JSON.stringify(initial)

        try {
            await assertRejects(() =>
                storage.sync.set({
                    links: { ...initial.links, enabled: 'not-a-boolean' },
                } as unknown as Partial<Sync>)
            )
            assertEquals((await storage.sync.get()).links, initial.links)
        } finally {
            localStorage.removeItem('bonjourr')
        }
    },
})

Deno.test({
    name: 'syncSet strips bookmark mirrors from persisted settings',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        localStorage.removeItem('bonjourr')

        await storage.sync.set(
            {
                links: {
                    ...SYNC_DEFAULT.links,
                    folders: [{
                        id: 'folder-1',
                        title: 'Folder',
                        items: [],
                    }],
                    favorites: [{
                        id: 'bookmark-1',
                        title: 'Bookmark',
                        url: 'https://example.com',
                    }],
                },
            } as unknown as Parameters<typeof storage.sync.set>[0],
        )
        const sync = await storage.sync.get()

        assertEquals('folders' in sync.links, false)
        assertEquals('favorites' in sync.links, false)
    },
})

Deno.test({
    name: 'sync storage strips unknown fields and local synchronization metadata',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        storage.type.set('localstorage')
        await storage.sync.replace(structuredClone(SYNC_DEFAULT))

        await storage.sync.set(
            {
                lang: 'ja',
                gistToken: 'must-not-enter-config',
                remoteResourceId: 'must-not-enter-config',
                lastSyncedPayload: 'must-not-enter-config',
                unexpected: 'must-not-enter-config',
            } as unknown as Parameters<typeof storage.sync.set>[0],
        )

        const saved = await storage.sync.get() as Sync & Record<string, unknown>
        const persisted = JSON.parse(localStorage.bonjourr) as Record<string, unknown>
        assertEquals(saved.lang, 'ja')
        for (const key of ['gistToken', 'remoteResourceId', 'lastSyncedPayload', 'unexpected']) {
            assertEquals(key in saved, false)
            assertEquals(key in persisted, false)
        }
    },
})

Deno.test({
    name: 'startup discards an incomplete staged transaction instead of overwriting newer config',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        storage.type.set('localstorage')
        sessionStorage.clear()

        const target = structuredClone(SYNC_DEFAULT)
        target.lang = 'fr'
        storage.stageSyncForReload(target)

        const newer = structuredClone(SYNC_DEFAULT)
        newer.lang = 'ja'
        await storage.sync.replace(newer)

        const initialized = await storage.init()
        assertEquals(initialized.sync.lang, 'ja')
        assertEquals((await storage.sync.get()).lang, 'ja')

        // A second init proves the journal was consumed and cannot replay.
        assertEquals((await storage.init()).sync.lang, 'ja')
        sessionStorage.clear()
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
        await storage.local.set({ backgroundLastChange: '2024-01-01' })
        const local = await storage.local.get('backgroundLastChange')

        assertEquals(local.backgroundLastChange, '2024-01-01')
    },
})

Deno.test({
    name: 'corrupted local cache metadata is isolated from valid synchronization state',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        storage.type.set('localstorage')
        localStorage.setItem('syncType', 'gist')
        localStorage.setItem('gistToken', 'valid-token')
        localStorage.setItem('backgroundCollections', '{"broken":"not-an-array"}')

        try {
            const local = await storage.local.get()
            assertEquals(local.syncType, 'gist')
            assertEquals(local.gistToken, 'valid-token')
            assertEquals(local.backgroundCollections, {})
        } finally {
            for (const key of ['syncType', 'gistToken', 'backgroundCollections']) {
                localStorage.removeItem(key)
            }
        }
    },
})

Deno.test({
    name: 'localGet keeps lastSyncedPayload as a string even when it looks like JSON',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const payload = '{"notes":{"records":[{"content":"new note"}]}}'

        await storage.local.set({ lastSyncedPayload: payload })
        const local = await storage.local.get('lastSyncedPayload')

        assertEquals(local.lastSyncedPayload, payload)
        assertEquals(typeof local.lastSyncedPayload, 'string')
    },
})

Deno.test({
    name: 'localGet preserves numeric-looking remote identifiers as strings',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await storage.local.set({ remoteResourceId: '1234567890' })
        const local = await storage.local.get('remoteResourceId')

        assertEquals(local.remoteResourceId, '1234567890')
        assertEquals(typeof local.remoteResourceId, 'string')
    },
})

Deno.test({
    name: 'localRemove deletes a local key',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await storage.local.set({ backgroundLastChange: '2024-06-01' })
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

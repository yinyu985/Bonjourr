import './init.test.ts'

import { assertEquals } from '@std/assert'
import { storage } from '../src/scripts/storage.ts'
import { LOCAL_DEFAULT, SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import { backgroundUpdate, waitForPendingBackgroundWrites } from '../src/scripts/features/backgrounds/index.ts'
import { buildBookmarkSnapshotFromConfig } from '../src/scripts/features/links/bookmarks.ts'
import { __testing as syncTesting } from '../src/scripts/features/synchronization/index.ts'
import { settingsInit, updateSettingsJson } from '../src/scripts/settings.ts'
import { loadCallbacks } from '../src/scripts/utils/onsettingsload.ts'
import type { Sync } from '../src/types/sync.ts'

// These tests drive the *real* backgroundUpdate query path (the function the
// settings "search" input wires Enter/submit/change/blur to) against the real
// storage layer, to prove the keyword is actually persisted locally. They guard
// against regressions in the runtime-version guard and the saveBackgroundPatch
// read-merge-write that the query handler relies on.

function setupDom(): void {
    document.body.innerHTML = `
        <div id="background-wrapper" data-type="images"></div>
        <div id="background-media"></div>
        <form id="f_background-user-search"><input id="i_background-user-search" /><small></small><button></button></form>
        <form id="f_background-user-coll"><input id="i_background-user-coll" /><small></small><button></button></form>
        <div id="background-user-coll-option"></div>
        <div id="background-user-search-option"></div>
        <select id="i_background-provider"></select>
        <select id="i_freq"></select>
        <div id="background-provider-option"></div>
        <form id="f_gistsync"><input /><small></small><button></button></form>
        <div id="linkblocks"></div>
        <div id="link-mini"></div>
        <textarea id="settings-data"></textarea>
    `
}

async function resetStorage(): Promise<void> {
    localStorage.removeItem('bonjourr')
    const def = structuredClone(SYNC_DEFAULT) as Sync
    def.backgrounds.type = 'images'
    def.backgrounds.images = 'unsplash-images-random'
    def.backgrounds.frequency = 'hour'
    await storage.sync.set({ backgrounds: def.backgrounds })
}

// backgroundCacheControl reaches out to the configured image provider.
// Stub fetch with a 500 so fetchNewBackgrounds returns null and the cache
// control path bails out early instead of throwing — we only care that the
// query got persisted, not that a real image loaded.
let fetchUrls: string[] = []

function stubFetch(): void {
    fetchUrls = []
    globalThis.fetch = ((input: string | URL | Request) => {
        fetchUrls.push(String(input))
        return Promise.resolve(
            new Response('stub', { status: 500, headers: { 'content-type': 'text/plain' } }),
        )
    }) as typeof globalThis.fetch
}

Deno.test({
    name: 'backgroundUpdate query path persists the keyword after Enter',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        setupDom()
        stubFetch()
        loadCallbacks()
        await resetStorage()

        const input = document.getElementById('i_background-user-search') as HTMLInputElement
        input.value = 'sky'

        await backgroundUpdate({ provider: 'unsplash-images-search' })

        // Submitting the search form resolves collectionName from the form id.
        await backgroundUpdate({
            query: { targetId: 'i_background-user-search', value: 'sky' },
        })

        const after = await storage.sync.get('backgrounds')
        assertEquals(after.backgrounds.images, 'unsplash-images-search')
        assertEquals(after.backgrounds.query, 'sky')
        assertEquals('queries' in after.backgrounds, false)
    },
})

Deno.test({
    name: 'backgroundUpdate collection URL persists the collection id as the plain query',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        setupDom()
        stubFetch()
        loadCallbacks()
        await resetStorage()

        await backgroundUpdate({ provider: 'unsplash-images-collections' })
        await backgroundUpdate({
            query: {
                targetId: 'i_background-user-coll',
                value: 'https://unsplash.com/collections/abc123/my-collection',
            },
        })

        const after = await storage.sync.get('backgrounds')
        assertEquals(after.backgrounds.images, 'unsplash-images-collections')
        assertEquals(after.backgrounds.query, 'abc123')
        assertEquals('queries' in after.backgrounds, false)
    },
})

Deno.test({
    name: 'settings UI Enter on custom search exports plain query',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        stubFetch()
        globalThis.caches.open = (() =>
            Promise.resolve({
                keys: () => Promise.resolve([]),
                match: () => Promise.resolve(undefined),
                delete: () => Promise.resolve(true),
            } as unknown as Cache)) as typeof globalThis.caches.open
        localStorage.removeItem('bonjourr')

        const sync = structuredClone(SYNC_DEFAULT) as Sync
        sync.backgrounds.type = 'color'
        sync.backgrounds.images = 'unsplash-images-random'
        sync.backgrounds.frequency = 'hour'
        await storage.sync.set(sync)

        const settingsHtml = await Deno.readTextFile('src/settings.html')
        document.body.innerHTML = `
            <button id="show-settings"></button>
            <button id="show-notes"></button>
            <main id="interface"></main>
            <div id="linkblocks"></div>
            <div id="link-mini"></div>
            <div id="background-wrapper" data-type="color"></div>
            <div id="background-media"></div>
            <div id="settings" class="hidden init">${settingsHtml}</div>
        `

        settingsInit(sync, structuredClone(LOCAL_DEFAULT))
        document.getElementById('show-settings')?.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
        )
        await new Promise((resolve) => setTimeout(resolve, 550))

        const type = document.getElementById('i_type') as HTMLSelectElement
        type.value = 'images'
        type.dispatchEvent(new Event('change', { bubbles: true }))
        await waitForPendingBackgroundWrites()

        const provider = document.getElementById('i_background-provider') as HTMLSelectElement
        provider.value = 'unsplash-images-search'
        provider.dispatchEvent(new Event('change', { bubbles: true }))
        await waitForPendingBackgroundWrites()

        const input = document.getElementById('i_background-user-search') as HTMLInputElement
        input.value = 'sky'
        ;(document.getElementById('f_background-user-search') as HTMLFormElement).dispatchEvent(
            new SubmitEvent('submit', { bubbles: true, cancelable: true }),
        )
        await waitForPendingBackgroundWrites()

        await updateSettingsJson()

        const textarea = document.getElementById('settings-data') as HTMLTextAreaElement
        const exported = JSON.parse(textarea.value) as Sync

        assertEquals(exported.backgrounds.images, 'unsplash-images-search')
        assertEquals(exported.backgrounds.query, 'sky')
        assertEquals('queries' in exported.backgrounds, false)
    },
})

Deno.test({
    name: 'background provider switch racing with Enter still persists query',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        setupDom()
        stubFetch()
        loadCallbacks()
        await resetStorage()

        const input = document.getElementById('i_background-user-search') as HTMLInputElement
        input.value = 'sky'

        await Promise.all([
            backgroundUpdate({ provider: 'unsplash-images-search' }),
            backgroundUpdate({ query: { targetId: 'i_background-user-search', value: 'sky' } }),
        ])

        const after = await storage.sync.get('backgrounds')
        assertEquals(after.backgrounds.images, 'unsplash-images-search')
        assertEquals(after.backgrounds.query, 'sky')
        assertEquals('queries' in after.backgrounds, false)
    },
})

Deno.test({
    name: 'background query draft persists typed search before Enter',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        setupDom()
        stubFetch()
        loadCallbacks()
        await resetStorage()

        await backgroundUpdate({ provider: 'unsplash-images-search' })
        await backgroundUpdate({
            querydraft: { targetId: 'i_background-user-search', value: 'sky' },
        })

        const after = await storage.sync.get('backgrounds')
        assertEquals(after.backgrounds.images, 'unsplash-images-search')
        assertEquals(after.backgrounds.query, 'sky')
        assertEquals('queries' in after.backgrounds, false)
        assertEquals(fetchUrls.length, 0)
    },
})

Deno.test({
    name: 'delayed Chrome storage provider write cannot wipe a query that already changed the image',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        setupDom()
        stubFetch()
        loadCallbacks()

        const previousType = storage.type.get()
        const globalWithChrome = globalThis as typeof globalThis & { chrome?: typeof chrome }
        const previousChrome = globalWithChrome.chrome
        const sync = structuredClone(SYNC_DEFAULT) as Sync
        sync.backgrounds.type = 'images'
        sync.backgrounds.images = 'unsplash-images-random'
        sync.backgrounds.query = ''

        const chromeStore = {
            ...structuredClone(LOCAL_DEFAULT),
            syncStorage: sync,
        } as Record<string, unknown> & { syncStorage: Sync }
        let firstSyncSetRelease: (() => void) | undefined
        let syncStorageSetCount = 0

        const cloneSelection = (keys?: string | string[]): Record<string, unknown> => {
            if (keys === undefined) {
                return structuredClone(chromeStore)
            }

            const selected: Record<string, unknown> = {}
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                selected[key] = structuredClone(chromeStore[key])
            }
            return selected
        }

        Object.defineProperty(globalWithChrome, 'chrome', {
            configurable: true,
            value: {
                storage: {
                    local: {
                        get: (keys?: string | string[]) => Promise.resolve(cloneSelection(keys)),
                        set: async (value: Record<string, unknown>) => {
                            if ('syncStorage' in value) {
                                syncStorageSetCount += 1

                                if (syncStorageSetCount === 1) {
                                    await new Promise<void>((resolve) => {
                                        firstSyncSetRelease = resolve
                                    })
                                }
                            }

                            Object.assign(chromeStore, structuredClone(value))
                        },
                        remove: (keys: string | string[]) => {
                            for (const key of Array.isArray(keys) ? keys : [keys]) {
                                delete chromeStore[key]
                            }
                            return Promise.resolve()
                        },
                        clear: () => {
                            for (const key of Object.keys(chromeStore)) {
                                delete chromeStore[key]
                            }
                            return Promise.resolve()
                        },
                    },
                },
            } as unknown as typeof chrome,
        })
        storage.type.set('webext-local')

        try {
            const queryWrite = backgroundUpdate({
                query: { targetId: 'i_background-user-search', value: 'sky' },
            })

            while (!firstSyncSetRelease) {
                await new Promise((resolve) => setTimeout(resolve, 1))
            }

            const providerWrite = backgroundUpdate({ provider: 'unsplash-images-search' })

            await new Promise((resolve) => setTimeout(resolve, 50))
            firstSyncSetRelease()
            await Promise.all([queryWrite, providerWrite])

            assertEquals(chromeStore.syncStorage.backgrounds.images, 'unsplash-images-search')
            assertEquals(chromeStore.syncStorage.backgrounds.query, 'sky')
            assertEquals('queries' in chromeStore.syncStorage.backgrounds, false)
        } finally {
            storage.type.set(previousType)
            if (previousChrome) {
                Object.defineProperty(globalWithChrome, 'chrome', {
                    configurable: true,
                    value: previousChrome,
                })
            } else {
                Reflect.deleteProperty(globalWithChrome, 'chrome')
            }
        }
    },
})

Deno.test({
    name: 'settings UI typed custom search updates visible export JSON without manual refresh',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        stubFetch()
        globalThis.caches.open = (() =>
            Promise.resolve({
                keys: () => Promise.resolve([]),
                match: () => Promise.resolve(undefined),
                delete: () => Promise.resolve(true),
            } as unknown as Cache)) as typeof globalThis.caches.open
        localStorage.removeItem('bonjourr')

        const sync = structuredClone(SYNC_DEFAULT) as Sync
        sync.backgrounds.type = 'color'
        sync.backgrounds.images = 'unsplash-images-random'
        sync.backgrounds.frequency = 'hour'
        await storage.sync.set(sync)

        const settingsHtml = await Deno.readTextFile('src/settings.html')
        document.body.innerHTML = `
            <button id="show-settings"></button>
            <button id="show-notes"></button>
            <main id="interface"></main>
            <div id="linkblocks"></div>
            <div id="link-mini"></div>
            <div id="background-wrapper" data-type="color"></div>
            <div id="background-media"></div>
            <div id="settings" class="hidden init">${settingsHtml}</div>
        `

        settingsInit(sync, structuredClone(LOCAL_DEFAULT))
        document.getElementById('show-settings')?.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
        )
        await new Promise((resolve) => setTimeout(resolve, 550))

        const type = document.getElementById('i_type') as HTMLSelectElement
        type.value = 'images'
        type.dispatchEvent(new Event('change', { bubbles: true }))
        await waitForPendingBackgroundWrites()

        const provider = document.getElementById('i_background-provider') as HTMLSelectElement
        provider.value = 'unsplash-images-search'
        provider.dispatchEvent(new Event('change', { bubbles: true }))
        await waitForPendingBackgroundWrites()

        const input = document.getElementById('i_background-user-search') as HTMLInputElement
        input.value = 'sky'
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'sky' }))
        await new Promise((resolve) => setTimeout(resolve, 300))
        await waitForPendingBackgroundWrites()

        const textarea = document.getElementById('settings-data') as HTMLTextAreaElement
        const exported = JSON.parse(textarea.value) as Sync

        assertEquals(exported.backgrounds.images, 'unsplash-images-search')
        assertEquals(exported.backgrounds.query, 'sky')
        assertEquals('queries' in exported.backgrounds, false)
    },
})

Deno.test({
    name: 'backgroundUpdate query appears in settings export JSON',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        setupDom()
        stubFetch()
        loadCallbacks()
        await resetStorage()

        await backgroundUpdate({ provider: 'unsplash-images-search' })
        await backgroundUpdate({
            query: { targetId: 'i_background-user-search', value: 'sky' },
        })
        await updateSettingsJson()

        const textarea = document.getElementById('settings-data') as HTMLTextAreaElement
        const exported = JSON.parse(textarea.value) as Sync
        assertEquals(exported.backgrounds.images, 'unsplash-images-search')
        assertEquals(exported.backgrounds.query, 'sky')
        assertEquals('queries' in exported.backgrounds, false)
    },
})

Deno.test({
    name: 'backgroundUpdate query is included in upload snapshot',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        setupDom()
        stubFetch()
        loadCallbacks()
        await resetStorage()

        await backgroundUpdate({ provider: 'unsplash-images-search' })
        await backgroundUpdate({
            query: { targetId: 'i_background-user-search', value: 'sky' },
        })

        const snapshot = await buildBookmarkSnapshotFromConfig(await storage.sync.get())
        assertEquals(snapshot.backgrounds.images, 'unsplash-images-search')
        assertEquals(snapshot.backgrounds.query, 'sky')
    },
})

Deno.test({
    name: 'settings export waits for an in-flight background query save',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        setupDom()
        stubFetch()
        loadCallbacks()
        await resetStorage()
        await backgroundUpdate({ provider: 'unsplash-images-search' })

        const pending = backgroundUpdate({
            query: { targetId: 'i_background-user-search', value: 'sky' },
        })

        await updateSettingsJson()

        const textarea = document.getElementById('settings-data') as HTMLTextAreaElement
        const exported = JSON.parse(textarea.value) as Sync
        assertEquals(exported.backgrounds.query, 'sky')

        await pending
    },
})

Deno.test({
    name: 'upload snapshot waits for an in-flight background query save',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        setupDom()
        stubFetch()
        loadCallbacks()
        await resetStorage()
        await backgroundUpdate({ provider: 'unsplash-images-search' })

        const pending = backgroundUpdate({
            query: { targetId: 'i_background-user-search', value: 'sky' },
        })

        const snapshot = await syncTesting.buildUploadSnapshot()
        assertEquals(snapshot.backgrounds.query, 'sky')

        await pending
    },
})

Deno.test({
    name: 'backgroundUpdate query survives submit + change + blur firing concurrently',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        setupDom()
        stubFetch()
        loadCallbacks()
        await resetStorage()

        const input = document.getElementById('i_background-user-search') as HTMLInputElement
        input.value = 'sky'

        await backgroundUpdate({ provider: 'unsplash-images-search' })

        // Enter inside a form can be followed by change and blur in close
        // succession; saveBackgroundQuery does not await backgroundUpdate, so
        // they can run concurrently. None of them must wipe the keyword.
        await Promise.all([
            backgroundUpdate({ query: { targetId: 'f_background-user-search', value: 'sky' } }),
            backgroundUpdate({ query: { targetId: 'i_background-user-search', value: 'sky' } }),
            backgroundUpdate({ query: { targetId: 'i_background-user-search', value: 'sky' } }),
        ])

        const after = await storage.sync.get('backgrounds')
        assertEquals(after.backgrounds.query, 'sky')
    },
})

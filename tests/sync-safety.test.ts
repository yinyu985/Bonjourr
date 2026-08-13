import './init.test.ts'

import { assertEquals, assertNotEquals, assertRejects, assertThrows } from '@std/assert'
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import { buildBookmarkSnapshotFromConfig } from '../src/scripts/features/links/bookmarks.ts'
import {
    getConfigSnapshots,
    restoreConfigSnapshot,
    saveExternalConfigSnapshot,
} from '../src/scripts/features/synchronization/backup.ts'
import { __testing as syncTesting } from '../src/scripts/features/synchronization/index.ts'
import { assertValidSyncInput } from '../src/scripts/features/synchronization/validation.ts'
import { storage } from '../src/scripts/storage.ts'

import type { Sync, SyncSnapshot } from '../src/types/sync.ts'

const SNAPSHOTS_KEY = 'bonjourr-archive-config-snapshots'
const { applyDownloadedSync, syncPayloadHash } = syncTesting

Deno.test('external configuration rejects unknown fields that could leak local synchronization secrets', () => {
    const external = snapshot('remote', 'ja') as SyncSnapshot & Record<string, unknown>
    external.gistToken = 'must-stay-local'

    assertThrows(() => assertValidSyncInput(external), Error, 'unknown field configuration.gistToken')
})

Deno.test('external configuration rejects duplicate bookmark ids and incomplete toolbar order', () => {
    const external = snapshot('remote', 'ja')
    external.links.folders = [{
        id: external.links.favorites[0].id,
        title: 'Duplicate',
        items: [],
    }]

    assertThrows(() => assertValidSyncInput(external), Error, 'duplicate bookmark id')

    const incomplete = snapshot('remote', 'ja')
    incomplete.links.folders = [{ id: 'folder', title: 'Folder', items: [] }]
    assertThrows(() => assertValidSyncInput(incomplete), Error, 'toolbarOrder does not match')

    const emptyUrl = snapshot('remote', 'ja')
    emptyUrl.links.favorites[0].url = ''
    assertThrows(() => assertValidSyncInput(emptyUrl), Error, 'malformed bookmark')
})

Deno.test('external configuration rejects unsafe URLs and pathological display values', () => {
    const unsafePage = snapshot('remote', 'ja')
    unsafePage.backgrounds.pausedImage = {
        format: 'image',
        urls: { full: 'https://example.com/full', small: 'https://example.com/small' },
        page: 'javascript:alert(1)',
        username: 'attacker',
    }
    assertThrows(() => assertValidSyncInput(unsafePage), Error, 'must be an HTTPS URL')

    const pathologicalRows = snapshot('remote', 'ja')
    pathologicalRows.links.rows = 1_000_000
    assertThrows(() => assertValidSyncInput(pathologicalRows), Error, 'outside its supported range')

    const unsupportedLanguage = snapshot('remote', 'ja')
    unsupportedLanguage.lang = '../../private'
    assertThrows(() => assertValidSyncInput(unsupportedLanguage), Error, 'unsupported configuration.lang')
})

Deno.test({
    name:
        'external configuration validation rejects malformed data before bookmarks, config, or recovery points change',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const current = snapshot('local', 'fr')
        const malformed = structuredClone(snapshot('remote', 'ja')) as unknown as Record<string, unknown>
        ;(malformed.backgrounds as Record<string, unknown>).bright = 'not-a-number'

        resetBookmarkTree(bookmarkTree('local-live', 'Local live', 'https://local.example'))
        localStorage.removeItem(SNAPSHOTS_KEY)
        await storage.sync.clear()
        await storage.sync.set(current)
        const bookmarksBefore = await chrome.bookmarks.getTree()

        try {
            await assertRejects(
                () => applyDownloadedSync(current, malformed as unknown as Partial<Sync>),
                Error,
                'wrong type',
            )

            assertEquals(await storage.sync.get(), persistedConfig(current))
            assertEquals(await chrome.bookmarks.getTree(), bookmarksBefore)
            assertEquals(await getConfigSnapshots(), [])
        } finally {
            await storage.sync.clear()
            localStorage.removeItem(SNAPSHOTS_KEY)
            resetBookmarkTree(bookmarkTree())
        }
    },
})

Deno.test({
    name: 'remote download without a complete bookmark snapshot fails closed before side effects',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const current = snapshot('local', 'fr')
        const missingBookmarks = structuredClone(SYNC_DEFAULT)
        missingBookmarks.lang = 'ja'

        resetBookmarkTree(bookmarkTree('local-live', 'Local live', 'https://local.example'))
        localStorage.removeItem(SNAPSHOTS_KEY)
        await storage.sync.clear()
        await storage.sync.set(current)
        const bookmarksBefore = await chrome.bookmarks.getTree()

        try {
            await assertRejects(
                () => applyDownloadedSync(current, missingBookmarks),
                Error,
                'bookmark snapshot is missing',
            )

            assertEquals(await storage.sync.get(), persistedConfig(current))
            assertEquals(await chrome.bookmarks.getTree(), bookmarksBefore)
            assertEquals(await getConfigSnapshots(), [])
        } finally {
            await storage.sync.clear()
            localStorage.removeItem(SNAPSHOTS_KEY)
            resetBookmarkTree(bookmarkTree())
        }
    },
})

Deno.test({
    name: 'toolbar payload hash ignores every Chrome bookmark id but preserves semantic order',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const first = idVariant('device-a')
        const second = idVariant('device-b')
        const reordered = idVariant('device-c')
        reordered.links.toolbarOrder = [
            'device-c-folder',
            'device-c-favorite',
        ]

        assertEquals(syncPayloadHash(first), syncPayloadHash(second))
        assertNotEquals(syncPayloadHash(first), syncPayloadHash(reordered))
    },
})

Deno.test({
    name: 'recovery snapshots are durable, newest-first, and capped at three',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        localStorage.removeItem(SNAPSHOTS_KEY)

        try {
            for (let index = 1; index <= 4; index++) {
                await saveExternalConfigSnapshot(snapshot(`snapshot-${index}`, `lang-${index}`), `reason-${index}`)
            }

            const persisted = localStorage.getItem(SNAPSHOTS_KEY)
            const snapshots = await getConfigSnapshots()

            assertEquals(typeof persisted, 'string')
            assertEquals(snapshots.length, 3)
            assertEquals(snapshots.map((item) => item.reason), ['reason-4', 'reason-3', 'reason-2'])
            assertEquals(snapshots.map((item) => item.config.tabtitle), [
                'snapshot-4',
                'snapshot-3',
                'snapshot-2',
            ])
        } finally {
            localStorage.removeItem(SNAPSHOTS_KEY)
        }
    },
})

Deno.test({
    name: 'restoring a recovery snapshot first persists the overwritten live state',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const current = structuredClone(SYNC_DEFAULT)
        current.lang = 'fr'
        const target = snapshot('remote-target', 'ja')

        localStorage.removeItem(SNAPSHOTS_KEY)
        sessionStorage.clear()
        resetBookmarkTree(bookmarkTree('local-live', 'Local live', 'https://local.example'))
        await storage.sync.clear()
        await storage.sync.set(current)
        await saveExternalConfigSnapshot(target, 'remote-target')

        try {
            assertEquals(await restoreConfigSnapshot(0), true)

            const saved = await storage.sync.get()
            const live = await buildBookmarkSnapshotFromConfig(saved)
            const snapshots = await getConfigSnapshots()

            assertEquals(saved.lang, 'ja')
            assertEquals(live.links.favorites.map((item) => item.title), ['remote-target'])
            assertEquals(snapshots.map((item) => item.reason), [
                'before-snapshot-restore',
                'remote-target',
            ])
            assertEquals(snapshots[0].config.lang, 'fr')
            assertEquals(snapshots[0].config.links.favorites.map((item) => item.title), ['Local live'])
        } finally {
            await storage.sync.clear()
            localStorage.removeItem(SNAPSHOTS_KEY)
            sessionStorage.clear()
            resetBookmarkTree(bookmarkTree())
        }
    },
})

Deno.test({
    name: 'malformed recovery snapshot is rejected before config, bookmarks, or archives change',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const current = snapshot('local', 'fr')
        const malformed = structuredClone(snapshot('broken', 'ja')) as unknown as Record<string, unknown>
        ;(malformed.links as Record<string, unknown>).folders = 'not-an-array'
        const archived = JSON.stringify([{
            timestamp: '2026-01-01T00:00:00.000Z',
            reason: 'malformed-target',
            config: malformed,
        }])

        resetBookmarkTree(bookmarkTree('local-live', 'Local live', 'https://local.example'))
        await storage.sync.clear()
        await storage.sync.set(current)
        localStorage.setItem(SNAPSHOTS_KEY, archived)
        const bookmarksBefore = await chrome.bookmarks.getTree()

        try {
            await assertRejects(() => restoreConfigSnapshot(0), Error, 'folders must be an array')

            assertEquals(await storage.sync.get(), persistedConfig(current))
            assertEquals(await chrome.bookmarks.getTree(), bookmarksBefore)
            assertEquals(localStorage.getItem(SNAPSHOTS_KEY), archived)
        } finally {
            await storage.sync.clear()
            localStorage.removeItem(SNAPSHOTS_KEY)
            resetBookmarkTree(bookmarkTree())
        }
    },
})

Deno.test({
    name: 'remote download rolls bookmarks and config back when the config commit fails',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const current = snapshot('local', 'fr')
        const remote = snapshot('remote', 'ja')

        resetBookmarkTree(bookmarkTree('local-live', 'Local live', 'https://local.example'))
        localStorage.removeItem(SNAPSHOTS_KEY)
        sessionStorage.clear()
        await storage.flushWrites()
        const failingStorage = installFailingFirstSyncCommit(persistedConfig(current))

        try {
            await assertRejects(
                () => applyDownloadedSync(current, remote),
                Error,
                'injected sync commit failure',
            )

            const saved = await storage.sync.get()
            const live = await buildBookmarkSnapshotFromConfig(saved)
            assertEquals(saved, persistedConfig(current))
            assertEquals(live.links.favorites.map((item) => item.title), ['Local live'])
            assertEquals(failingStorage.syncCommitAttempts(), 2)
            assertEquals(sessionStorage.length, 0)
            assertEquals((await getConfigSnapshots()).map((item) => item.reason), ['before-sync-download'])
        } finally {
            failingStorage.restore()
            await storage.sync.clear()
            localStorage.removeItem(SNAPSHOTS_KEY)
            sessionStorage.clear()
            resetBookmarkTree(bookmarkTree())
        }
    },
})

Deno.test({
    name: 'snapshot restore rolls bookmarks and config back when the config commit fails',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const current = snapshot('local', 'fr')
        const target = snapshot('target', 'ja')

        resetBookmarkTree(bookmarkTree('local-live', 'Local live', 'https://local.example'))
        localStorage.removeItem(SNAPSHOTS_KEY)
        sessionStorage.clear()
        await saveExternalConfigSnapshot(target, 'target')
        await storage.flushWrites()
        const failingStorage = installFailingFirstSyncCommit(persistedConfig(current))

        try {
            await assertRejects(
                () => restoreConfigSnapshot(0),
                Error,
                'injected sync commit failure',
            )

            const saved = await storage.sync.get()
            const live = await buildBookmarkSnapshotFromConfig(saved)
            assertEquals(saved, persistedConfig(current))
            assertEquals(live.links.favorites.map((item) => item.title), ['Local live'])
            assertEquals(failingStorage.syncCommitAttempts(), 2)
            assertEquals(sessionStorage.length, 0)
            assertEquals((await getConfigSnapshots()).map((item) => item.reason), [
                'before-snapshot-restore',
                'target',
            ])
        } finally {
            failingStorage.restore()
            await storage.sync.clear()
            localStorage.removeItem(SNAPSHOTS_KEY)
            sessionStorage.clear()
            resetBookmarkTree(bookmarkTree())
        }
    },
})

function snapshot(title: string, lang: string): SyncSnapshot {
    const config = structuredClone(SYNC_DEFAULT)
    config.lang = lang
    config.tabtitle = title
    return {
        ...config,
        links: {
            ...config.links,
            folders: [],
            favorites: [{
                id: `${title}-favorite`,
                title,
                url: `https://${title}.example`,
            }],
            toolbarOrder: [`${title}-favorite`],
        },
    }
}

function idVariant(prefix: string): SyncSnapshot {
    const config = structuredClone(SYNC_DEFAULT)
    return {
        ...config,
        links: {
            ...config.links,
            selectedFolder: `${prefix}-folder`,
            folders: [{
                id: `${prefix}-folder`,
                title: 'Work',
                items: [{
                    id: `${prefix}-nested-folder`,
                    title: 'Nested',
                    items: [{
                        id: `${prefix}-nested-bookmark`,
                        title: 'Docs',
                        url: 'https://docs.example',
                    }],
                }],
            }],
            favorites: [{
                id: `${prefix}-favorite`,
                title: 'Mail',
                url: 'mailto:user@example.com',
            }],
            toolbarOrder: [
                `${prefix}-favorite`,
                `${prefix}-folder`,
            ],
        },
    }
}

function persistedConfig(snapshot: SyncSnapshot): Sync {
    const result = structuredClone(snapshot) as Sync & {
        links: Sync['links'] & { folders?: unknown; favorites?: unknown; toolbarOrder?: unknown }
    }
    delete result.links.folders
    delete result.links.favorites
    delete result.links.toolbarOrder
    return result
}

function bookmarkTree(id?: string, title?: string, url?: string): chrome.bookmarks.BookmarkTreeNode[] {
    const children: chrome.bookmarks.BookmarkTreeNode[] = id && title && url
        ? [{ id, parentId: '1', index: 0, title, url, syncing: false }]
        : []

    return [{
        id: '0',
        title: '',
        syncing: false,
        children: [{
            id: '1',
            parentId: '0',
            title: 'Bookmarks bar',
            syncing: false,
            children,
        }],
    }]
}

function resetBookmarkTree(tree: chrome.bookmarks.BookmarkTreeNode[]): void {
    globalThis.startupBookmarks = structuredClone(tree)
    globalThis.dispatchEvent(new Event('bonjourr-test-bookmarks-reset'))
    globalThis.startupBookmarks = undefined
}

function installFailingFirstSyncCommit(initial: Sync): {
    restore: () => void
    syncCommitAttempts: () => number
} {
    const previousChrome = globalThis.chrome
    const previousStorageType = storage.type.get()
    const state: Record<string, unknown> = { syncStorage: structuredClone(initial) }
    let syncCommitAttempts = 0

    const area = {
        get(keys?: string | string[]): Promise<Record<string, unknown>> {
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
            if ('syncStorage' in value) {
                syncCommitAttempts += 1
                if (syncCommitAttempts === 1) {
                    return Promise.reject(new Error('injected sync commit failure'))
                }
            }
            Object.assign(state, structuredClone(value))
            return Promise.resolve()
        },
        remove(keys: string | string[]): Promise<void> {
            for (const key of typeof keys === 'string' ? [keys] : keys) delete state[key]
            return Promise.resolve()
        },
        clear(): Promise<void> {
            for (const key of Object.keys(state)) delete state[key]
            return Promise.resolve()
        },
    } as unknown as typeof chrome.storage.local

    Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        writable: true,
        value: {
            ...previousChrome,
            storage: { local: area },
        } as typeof chrome,
    })
    storage.type.set('webext-local')

    return {
        restore(): void {
            Object.defineProperty(globalThis, 'chrome', {
                configurable: true,
                writable: true,
                value: previousChrome,
            })
            storage.type.set(previousStorageType)
        },
        syncCommitAttempts(): number {
            return syncCommitAttempts
        },
    }
}

import './init.test.ts'

import { assertEquals, assertNotEquals, assertRejects } from '@std/assert'
import { storage } from '../src/scripts/storage.ts'
import { LOCAL_DEFAULT, SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import { buildBookmarkSnapshotFromConfig } from '../src/scripts/features/links/bookmarks.ts'
import { __testing } from '../src/scripts/features/synchronization/index.ts'
import { getLang } from '../src/scripts/utils/translations.ts'

import type { Local } from '../src/types/local.ts'
import type { LinkFolder, Sync, SyncSnapshot } from '../src/types/sync.ts'
import type { RemoteProvider } from '../src/scripts/features/synchronization/provider.ts'

const {
    applyDownloadedSync,
    doAutoUpload,
    remoteFreshness,
    replaceRemoteIdentity,
    resetSyncRuntimeForTests,
    startupPayloadDecision,
    syncPayloadHash,
} = __testing
const LOCKED_BACKGROUND_FULL_URL = 'https://example.com/remote-full.jpg'
const LOCKED_BACKGROUND_SMALL_URL = 'https://example.com/remote-small.jpg'

// 这一组测试是为了挡住几次踩过的同步坑：
//   - syncPayloadHash 对 notes 内容必须敏感（曾经被 stringify replacer 过滤掉过）
//   - selectedFolder 切换不算"内容变更"（避免每切个文件夹都上传一次 Gist）
//   - applyDownloadedSync 真的把远端没有的字段删干净（删除会跨设备传播）

// ---- syncPayloadHash ----

Deno.test({
    name: 'syncPayloadHash changes when a note body is edited',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const before = syncWithNote('hello')
        const after = syncWithNote('hello world')

        assertNotEquals(syncPayloadHash(before), syncPayloadHash(after))
    },
})

Deno.test({
    name: 'syncPayloadHash changes when a note title is edited',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const before = syncWithNote('body', 'Title A')
        const after = syncWithNote('body', 'Title B')

        assertNotEquals(syncPayloadHash(before), syncPayloadHash(after))
    },
})

Deno.test({
    name: 'syncPayloadHash ignores selectedFolder so navigation does not trigger uploads',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const a = structuredClone(SYNC_DEFAULT)
        const b = structuredClone(SYNC_DEFAULT)
        b.links.selectedFolder = 'something-else'

        assertEquals(syncPayloadHash(a), syncPayloadHash(b))
    },
})

Deno.test({
    name: 'syncPayloadHash changes when a link is added',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const a = syncWithFolders([{ id: 'test', title: 'test', items: [] }])
        const b = structuredClone(a)
        b.links.folders[0].items.push({
            id: 'links0001',
            title: 'New',
            url: 'https://example.com',
        })

        assertNotEquals(syncPayloadHash(a), syncPayloadHash(b))
    },
})

Deno.test({
    name: 'syncPayloadHash changes when a blank bookmark title is renamed',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const before = syncWithFavoriteTitle('')
        const after = syncWithFavoriteTitle('V2')

        assertNotEquals(syncPayloadHash(before), syncPayloadHash(after))
    },
})

Deno.test({
    name: 'startup payload baseline is not advanced after Chrome bookmark mirroring changes content',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const before = syncWithFavoriteTitle('')
        const after = syncWithFavoriteTitle('V2')
        const remotePayload = syncPayloadHash(before)
        const decision = startupPayloadDecision(
            localSyncState(),
            testProvider(),
            remotePayload,
            syncPayloadHash(after),
            '',
        )

        assertEquals(decision.pendingUpload, true)
        assertEquals(decision.runtimePayload, remotePayload)
        assertEquals(decision.persistedPayload, undefined)
    },
})

Deno.test({
    name: 'startup payload baseline is persisted when Chrome mirroring does not change content',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const current = syncWithFavoriteTitle('V2')
        const payload = syncPayloadHash(current)
        const decision = startupPayloadDecision(
            localSyncState(),
            testProvider(),
            payload,
            payload,
            '',
        )

        assertEquals(decision.pendingUpload, false)
        assertEquals(decision.runtimePayload, payload)
        assertEquals(decision.persistedPayload, payload)
    },
})

Deno.test({
    name: 'bookmark upload snapshot reads the live Chrome bookmark title',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const current = syncWithFavoriteTitle('')
        globalThis.startupBookmarks = bookmarkTreeWithFavoriteTitle('V2')

        const snapshot = await buildBookmarkSnapshotFromConfig(current)

        assertEquals(snapshot.links.favorites[0].title, 'V2')
        assertNotEquals(syncPayloadHash(current), syncPayloadHash(snapshot))

        globalThis.startupBookmarks = undefined
    },
})

Deno.test({
    name: 'remote freshness is unknown when metadata cannot be fetched',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const freshness = await remoteFreshness(localSyncState(), testProvider())

        assertEquals(freshness, 'unknown')
    },
})

Deno.test({
    name: 'remote freshness detects a newer remote timestamp',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const freshness = await remoteFreshness(
            localSyncState(),
            testProvider({
                fetchUpdatedAt: () => Promise.resolve('2026-01-01T00:00:02.500Z'),
            }),
        )

        assertEquals(freshness, 'newer')
    },
})

Deno.test({
    name: 'remote freshness fails closed for a non-UTC or malformed local baseline',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const freshness = await remoteFreshness(
            localSyncState({ remoteLastSyncedAt: '2026-01-01T00:00:00' }),
            testProvider({ fetchUpdatedAt: () => Promise.resolve('2026-01-01T00:00:00Z') }),
        )

        assertEquals(freshness, 'unknown')
    },
})

Deno.test({
    name: 'remote freshness is current without a bound remote resource',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const freshness = await remoteFreshness(
            localSyncState({ remoteResourceId: undefined }),
            testProvider(),
        )

        assertEquals(freshness, 'current')
    },
})

Deno.test({
    name: 'remote freshness fails closed for a bound resource without a baseline',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const freshness = await remoteFreshness(
            localSyncState({ remoteLastSyncedAt: undefined }),
            testProvider(),
        )

        assertEquals(freshness, 'unknown')
    },
})

Deno.test({
    name: 'stale runtime freshness cannot upload a newly bound resource without a baseline',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const originalFetch = globalThis.fetch
        const remote = emptyBookmarkSnapshot()
        remote.lang = 'ja'
        const requests: string[] = []

        await storage.sync.clear()
        await storage.local.clear()
        await storage.sync.set(structuredClone(SYNC_DEFAULT))
        await storage.local.set({
            syncType: 'gist',
            gistToken: 'new-account-token',
            remoteResourceId: 'new-account-resource',
            remoteLastSyncedAt: undefined,
            localConfigUpdatedAt: new Date().toISOString(),
        })
        // Simulate an old tab whose in-memory flag predates the token change.
        resetSyncRuntimeForTests('old-account-baseline')

        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            requests.push(`${method} ${String(input)}`)
            return Promise.resolve(jsonResponse({
                updated_at: '2026-01-01T00:00:00.000Z',
                files: {
                    'bonjourr-export.json': {
                        filename: 'bonjourr-export.json',
                        type: 'application/json',
                        language: 'JSON',
                        raw_url: 'https://gist.githubusercontent.com/user/id/raw/file',
                        size: JSON.stringify(remote).length,
                        content: JSON.stringify(remote),
                    },
                },
            }))
        }) as typeof fetch

        try {
            await doAutoUpload()

            assertEquals(requests.some((request) => request.startsWith('PATCH ')), false)
            assertEquals((await storage.local.get()).remoteLastSyncedAt, '')
        } finally {
            globalThis.fetch = originalFetch
            resetSyncRuntimeForTests()
            await storage.sync.clear()
            await storage.local.clear()
        }
    },
})

Deno.test({
    name: 'new remote identity is not persisted when old baseline cleanup fails',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const originalRemove = storage.local.remove
        await storage.local.clear()
        await storage.local.set({
            syncType: 'gist',
            gistToken: 'old-token',
            remoteResourceId: 'old-resource',
            remoteLastSyncedAt: '2026-01-01T00:00:00.000Z',
            lastSyncedPayload: 'old-payload',
        })
        storage.local.remove = () => Promise.reject(new Error('injected baseline cleanup failure'))

        try {
            await assertRejects(
                () =>
                    replaceRemoteIdentity(
                        testProvider({
                            clearPatch: () => [
                                'remoteResourceId',
                                'remoteLastSyncedAt',
                                'remoteLastFetchedAt',
                                'lastSyncedPayload',
                            ],
                        }),
                        'new-token',
                        'new-resource',
                    ),
                Error,
                'baseline cleanup failure',
            )

            const local = await storage.local.get()
            assertEquals(local.gistToken, 'old-token')
            assertEquals(local.remoteResourceId, 'old-resource')
            assertEquals(local.remoteLastSyncedAt, '2026-01-01T00:00:00.000Z')
        } finally {
            storage.local.remove = originalRemove
            await storage.local.clear()
        }
    },
})

Deno.test({
    name: 'auto upload records remote metadata and refreshes server status after note edits',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const originalFetch = globalThis.fetch
        const remoteBefore = '2026-01-01T00:00:00.000Z'
        const uploadedAt = '2026-01-01T00:05:00.000Z'
        const baseline = syncWithNote('old note')
        const latest = syncWithNote('new note')
        const baselinePayload = syncPayloadHash(await buildBookmarkSnapshotFromConfig(baseline))
        const requests: string[] = []

        document.body.innerHTML = `
            <div id="linkblocks"></div>
            <div id="link-mini"></div>
            <dialog id="contextmenu"></dialog>
            <main id="interface"></main>
            <div id="gist-sync-status-wrapper"><span id="gist-sync-status-base"></span></div>
        `
        sessionStorage.clear()
        await storage.sync.clear()
        await storage.local.clear()
        await storage.sync.set(latest)
        await storage.local.set({
            syncType: 'gist',
            gistToken: 'token',
            remoteResourceId: 'abc123',
            remoteLastSyncedAt: remoteBefore,
            localConfigUpdatedAt: '2026-01-01T00:01:00.000Z',
            lastSyncedPayload: baselinePayload,
        })
        resetSyncRuntimeForTests(baselinePayload)

        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            requests.push(`${method} ${String(input)}`)

            if (method === 'PATCH') {
                return Promise.resolve(jsonResponse({ updated_at: uploadedAt }))
            }

            return Promise.resolve(jsonResponse({
                updated_at: remoteBefore,
                html_url: 'https://gist.github.com/abc123',
            }))
        }) as typeof fetch

        try {
            await doAutoUpload()

            const local = await storage.local.get()
            const status = document.getElementById('gist-sync-status') as HTMLAnchorElement | null

            assertEquals(local.remoteLastSyncedAt, uploadedAt)
            assertEquals(local.localConfigUpdatedAt, uploadedAt)
            assertEquals(local.lastSyncedPayload, syncPayloadHash(await buildBookmarkSnapshotFromConfig(latest)))
            assertEquals(status?.getAttribute('href'), 'https://gist.github.com/abc123')
            assertEquals(status?.textContent, formatStatusDate(uploadedAt))
            assertEquals(requests, [
                'GET https://api.github.com/gists/abc123',
                'GET https://api.github.com/gists/abc123',
                'PATCH https://api.github.com/gists/abc123',
            ])
        } finally {
            globalThis.fetch = originalFetch
            resetSyncRuntimeForTests()
            await storage.sync.clear()
            await storage.local.clear()
            document.body.innerHTML = `
                <div id="linkblocks"></div>
                <div id="link-mini"></div>
                <dialog id="contextmenu"></dialog>
                <main id="interface"></main>
            `
        }
    },
})

// ---- applyDownloadedSync ----

Deno.test({
    name: 'applyDownloadedSync persists the incoming config and drops local-only keys',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        sessionStorage.clear()
        await storage.sync.clear()

        const current = structuredClone(SYNC_DEFAULT)
        current.lang = 'fr'
        current.tabtitle = 'local-only-tab-title'
        await storage.sync.set(current)

        const incoming = emptyBookmarkSnapshot()
        incoming.lang = 'ja'

        const next = await applyDownloadedSync(current, incoming)
        const saved = await storage.sync.get()

        assertEquals(next.lang, 'ja')
        assertEquals(saved.lang, 'ja')
        assertEquals(saved.tabtitle, SYNC_DEFAULT.tabtitle)
        sessionStorage.clear()
    },
})

Deno.test({
    name: 'syncPayloadHash is stable for the post-sync sync (no upload loop)',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        sessionStorage.clear()
        await storage.sync.clear()
        const current = structuredClone(SYNC_DEFAULT)
        const incoming = emptyBookmarkSnapshot()
        incoming.lang = 'de'

        const next = await applyDownloadedSync(current, incoming)
        const saved = await storage.sync.get()

        assertEquals(syncPayloadHash(next), syncPayloadHash(saved))
        sessionStorage.clear()
    },
})

Deno.test({
    name: 'applyDownloadedSync clears its staged reload snapshot after a successful commit',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        sessionStorage.clear()
        localStorage.removeItem('backgroundCache')
        await storage.sync.clear()

        const current = structuredClone(SYNC_DEFAULT)
        await storage.sync.set(current)

        const incoming = emptyBookmarkSnapshot()
        incoming.backgrounds.type = 'images'
        incoming.backgrounds.frequency = 'pause'
        incoming.backgrounds.texture = { type: 'none' }
        incoming.backgrounds.pausedImage = lockedBackground()

        const next = await applyDownloadedSync(current, incoming)

        assertEquals(next.backgrounds.pausedImage?.urls.full, LOCKED_BACKGROUND_FULL_URL)
        assertEquals(localStorage.getItem('backgroundCache'), LOCKED_BACKGROUND_FULL_URL)

        const newer = structuredClone(SYNC_DEFAULT)
        newer.lang = 'fr'
        await storage.sync.replace(newer)

        const initialized = await storage.init()
        const saved = await storage.sync.get()

        assertEquals(initialized.sync.lang, 'fr')
        assertEquals(initialized.sync.backgrounds.type, SYNC_DEFAULT.backgrounds.type)
        assertEquals(saved.lang, 'fr')
        assertEquals(saved.backgrounds.type, SYNC_DEFAULT.backgrounds.type)

        sessionStorage.clear()
        localStorage.removeItem('backgroundCache')
    },
})

// ---- helpers ----

function syncWithNote(content: string, title = 'Untitled'): Sync {
    const data = structuredClone(SYNC_DEFAULT)
    data.notes = {
        active: 'note-1',
        records: [{
            id: 'note-1',
            title,
            content,
            updatedAt: '2026-01-01T00:00:00.000Z',
        }],
    }
    return data
}

function emptyBookmarkSnapshot(): SyncSnapshot {
    const sync = structuredClone(SYNC_DEFAULT) as SyncSnapshot
    sync.links = { ...sync.links, folders: [], favorites: [], toolbarOrder: [] }
    return sync
}

function syncWithFavoriteTitle(title: string): SyncSnapshot {
    const data = structuredClone(SYNC_DEFAULT)
    return {
        ...data,
        links: {
            ...data.links,
            folders: [],
            favorites: [{
                id: 'bookmark-1',
                title,
                url: 'https://example.com',
            }],
        },
    }
}

function syncWithFolders(folders: LinkFolder[]): SyncSnapshot {
    const data = structuredClone(SYNC_DEFAULT)
    return {
        ...data,
        links: {
            ...data.links,
            folders,
            favorites: [],
        },
    }
}

function localSyncState(overrides: Partial<Local> = {}): Local {
    return {
        ...structuredClone(LOCAL_DEFAULT),
        syncType: 'gist',
        gistToken: 'token',
        remoteResourceId: 'gist-1',
        remoteLastSyncedAt: '2026-01-01T00:00:00.000Z',
        localConfigUpdatedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    }
}

function testProvider(overrides: Partial<RemoteProvider> = {}): RemoteProvider {
    const provider: RemoteProvider = {
        kind: 'gist',
        isEnabled: () => true,
        isAuthorized: () => true,
        getResourceId: (local) => local.remoteResourceId,
        getLastSyncedAt: (local) => local.remoteLastSyncedAt,
        getLastFetchedAt: (local) => local.remoteLastFetchedAt,
        fetchedPatch: (remoteLastFetchedAt) => ({ remoteLastFetchedAt }),
        syncedPatch: (metadata) => ({
            remoteResourceId: metadata.resourceId,
            remoteLastSyncedAt: metadata.updatedAt,
            localConfigUpdatedAt: metadata.updatedAt,
        }),
        clearPatch: () => [],
        findResource: () => Promise.resolve(undefined),
        fetchUpdatedAt: () => Promise.resolve(undefined),
        download: () => Promise.reject(new Error('unused')),
        upload: () => Promise.reject(new Error('unused')),
        setStatus: () => {},
        setStatusNow: () => {},
    }

    return {
        ...provider,
        ...overrides,
    }
}

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    })
}

function formatStatusDate(isoDate: string): string {
    return new Date(isoDate).toLocaleString(getLang(), {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    })
}

function bookmarkTreeWithFavoriteTitle(title: string): chrome.bookmarks.BookmarkTreeNode[] {
    return [{
        id: '0',
        title: '',
        syncing: false,
        children: [{
            id: '1',
            title: 'Bookmarks Bar',
            syncing: false,
            children: [{
                id: 'bookmark-1',
                parentId: '1',
                title,
                url: 'https://example.com',
                dateAdded: 1,
                syncing: false,
            }],
        }],
    }]
}

function lockedBackground(): NonNullable<Sync['backgrounds']['pausedImage']> {
    return {
        format: 'image',
        urls: {
            full: LOCKED_BACKGROUND_FULL_URL,
            small: LOCKED_BACKGROUND_SMALL_URL,
        },
        color: '#123456',
    }
}

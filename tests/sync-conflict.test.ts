import './init.test.ts'

import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { storage } from '../src/scripts/storage.ts'
import { LOCAL_DEFAULT, SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import { buildBookmarkSnapshotFromConfig } from '../src/scripts/features/links/bookmarks.ts'
import { __testing } from '../src/scripts/features/synchronization/index.ts'

import type { Local } from '../src/types/local.ts'
import type { Sync, SyncSnapshot } from '../src/types/sync.ts'
import type { RemoteProvider, RemoteSnapshot } from '../src/scripts/features/synchronization/provider.ts'

const {
    autoSyncOnStartup,
    completeStartupFreshnessCheck,
    getPendingConflictMessage,
    resetSyncRuntimeForTests,
    syncPayloadHash,
} = __testing

// fadeOut() schedules location.reload(); stub it so the test runner isn't killed.
function stubReload(): void {
    const w = globalThis as unknown as { location: { reload: () => void } }
    w.location.reload = () => {}
}

// Remote snapshot: a stale config the user uploaded before typing "sky" — it
// has unsplash-images-search selected but no keyword. "sky" is the local edit
// that has not been uploaded yet.
function remoteSnapshotWithoutSky(updatedAt: string): RemoteSnapshot {
    const sync = structuredClone(SYNC_DEFAULT) as SyncSnapshot
    sync.links = { ...sync.links, folders: [], favorites: [], toolbarOrder: [] }
    sync.backgrounds.type = 'images'
    sync.backgrounds.images = 'unsplash-images-search'
    sync.backgrounds.query = ''
    return {
        metadata: { provider: 'gist', resourceId: 'gist-1', updatedAt },
        sync,
    }
}

// Local config: the user just typed "sky" and pressed Enter, already written
// to storage.sync.
async function seedLocalWithSky(): Promise<void> {
    sessionStorage.clear()
    await storage.sync.clear()
    // fadeOut() clicks #interface and reloads; give the test DOM a stub so the
    // auto-download path doesn't crash before we can assert on storage.
    document.body.innerHTML += '<div id="interface"></div>'
    const sync = structuredClone(SYNC_DEFAULT) as Sync
    sync.backgrounds.type = 'images'
    sync.backgrounds.images = 'unsplash-images-search'
    sync.backgrounds.query = 'sky'
    await storage.sync.set(sync)
}

function localState(overrides: Partial<Local> = {}): Local {
    return {
        ...structuredClone(LOCAL_DEFAULT),
        syncType: 'gist',
        gistToken: 'token',
        remoteResourceId: 'gist-1',
        ...overrides,
    }
}

function testProvider(
    snapshot: RemoteSnapshot,
    setStatusNow: RemoteProvider['setStatusNow'] = () => {},
): RemoteProvider {
    return {
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
        fetchUpdatedAt: () => Promise.resolve(snapshot.metadata.updatedAt),
        download: () => Promise.resolve(snapshot),
        upload: () => Promise.reject(new Error('unused')),
        setStatus: () => {},
        setStatusNow,
    }
}

// SPEC §2.8: without a remoteLastSyncedAt baseline the machine cannot
// reliably tell whether the remote is "newer". The automatic flow must not
// overwrite either side; it only records the fetched state and prompts the
// user to manually upload or download to establish a baseline.
Deno.test({
    name: 'startup sync WITHOUT a baseline must not wipe unsynced local edits (no remoteLastSyncedAt)',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        stubReload()
        await seedLocalWithSky()

        const local = localState({ remoteLastSyncedAt: undefined })
        const provider = testProvider(remoteSnapshotWithoutSky('2026-01-01T00:00:00.000Z'))

        const result = await completeStartupFreshnessCheck(local, provider)

        const after = await storage.sync.get('backgrounds')
        // No baseline → must not auto-overwrite the local side. "sky" survives.
        assertEquals(result, 'conflict')
        assertEquals(after.backgrounds.query, 'sky')
        sessionStorage.clear()
    },
})

// SPEC §2.7: remote moved on AND the local side has unsynced edits → conflict.
// The automatic flow must not silently overwrite either side; the user picks
// Upload (local wins) or Download (remote wins) by hand.
Deno.test({
    name: 'startup sync with a newer remote AND unsynced local edits must not auto-download (conflict)',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        stubReload()
        await seedLocalWithSky()

        // Last sync at T1, local edits dirty at T2 (after T1).
        // Remote updatedAt at T3 (after T1) → remote is newer.
        const local = localState({
            remoteLastSyncedAt: '2026-01-01T00:00:00.000Z',
            localConfigUpdatedAt: '2026-01-02T00:00:00.000Z',
        })
        const provider = testProvider(remoteSnapshotWithoutSky('2026-01-03T00:00:00.000Z'))

        const result = await completeStartupFreshnessCheck(local, provider)

        const after = await storage.sync.get('backgrounds')
        // Conflict → local "sky" survives, waiting for a manual decision.
        assertEquals(result, 'conflict')
        assertEquals(after.backgrounds.query, 'sky')
        sessionStorage.clear()
    },
})

// Remote is newer but the local side is clean → safe to auto-download (remote
// wins). Guards against the conflict guard over-firing and blocking the
// existing "remote wins" behavior when there are no unsynced local edits.
Deno.test({
    name: 'startup sync with a newer remote but NO local edits still auto-downloads (remote wins)',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        stubReload()
        // Local config matches the remote (both have no "sky", no unsynced
        // edits). lastSyncedPayload is seeded from the upload snapshot so the
        // payload comparison sees "no change since last sync".
        sessionStorage.clear()
        await storage.sync.clear()
        const sync = structuredClone(SYNC_DEFAULT) as Sync
        sync.backgrounds.type = 'images'
        sync.backgrounds.images = 'unsplash-images-search'
        sync.backgrounds.query = ''
        await storage.sync.set(sync)
        document.body.innerHTML += '<div id="interface"></div>'

        const remote = remoteSnapshotWithoutSky('2026-01-03T00:00:00.000Z')
        const current = await storage.sync.get() as Sync
        const uploadSnapshot = await buildBookmarkSnapshotFromConfig(current)
        const baseline = syncPayloadHash(uploadSnapshot)

        const local = localState({
            remoteLastSyncedAt: '2026-01-01T00:00:00.000Z',
            localConfigUpdatedAt: '2026-01-01T00:00:00.000Z',
            lastSyncedPayload: baseline,
        })
        await storage.local.set({ lastSyncedPayload: baseline })
        let renderedMetadata: Parameters<RemoteProvider['setStatusNow']>[0]
        const provider = testProvider(remote, (metadata) => {
            renderedMetadata = metadata
        })

        const result = await completeStartupFreshnessCheck(local, provider)

        // Clean local + newer remote → remote wins, downloaded path taken.
        assertEquals(result, 'downloaded')
        assertEquals((await storage.sync.get('backgrounds')).backgrounds.query, '')
        assertEquals(renderedMetadata, remote.metadata)
        sessionStorage.clear()
    },
})

// The conflict message must tell the user WHICH side is newer: it carries the
// local and remote last-changed timestamps so a human can decide between
// Send (local wins) and Get (remote wins).
Deno.test({
    name: 'conflict message includes local and remote last-changed timestamps',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        stubReload()
        resetSyncRuntimeForTests()
        await seedLocalWithSky()

        const local = localState({
            remoteLastSyncedAt: '2026-01-01T00:00:00.000Z',
            localConfigUpdatedAt: '2026-01-02T00:00:00.000Z',
        })
        const provider = testProvider(remoteSnapshotWithoutSky('2026-01-03T00:00:00.000Z'))

        const result = await completeStartupFreshnessCheck(local, provider)
        const message = getPendingConflictMessage()

        assertEquals(result, 'conflict')
        assertStringIncludes(message, 'Local and remote both changed since last sync.')
        assertStringIncludes(message, 'Local last changed')
        assertStringIncludes(message, 'Remote last changed')
        assertStringIncludes(message, 'Click Send to overwrite remote, or Get to overwrite local.')
        // Both timestamps are valid ISO dates → neither line falls back to "unknown".
        assert(!message.includes('unknown'))
        assertEquals(message.split('\n').length, 4)

        resetSyncRuntimeForTests()
        sessionStorage.clear()
    },
})

// A dead network on startup is not an application error. It must not reach
// console.warn (Chrome's extension error panel collects those); instead a
// human-readable message is parked for the settings sync form.
Deno.test({
    name: 'startup sync network failure stays silent in console and parks a message for the sync form',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        resetSyncRuntimeForTests()

        const originalFetch = globalThis.fetch
        const originalWarn = console.warn
        const warnings: unknown[][] = []
        globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'))
        console.warn = (...args: unknown[]) => {
            warnings.push(args)
        }

        try {
            const local = localState({
                remoteLastSyncedAt: '2026-01-01T00:00:00.000Z',
            })
            await storage.local.set(local)
            const result = await autoSyncOnStartup(local)

            assertEquals(result, 'failed')
            assertEquals(getPendingConflictMessage(), 'Cannot connect to GitHub.')
            assertEquals(warnings.length, 0)
        } finally {
            globalThis.fetch = originalFetch
            console.warn = originalWarn
            resetSyncRuntimeForTests()
            await storage.local.clear()
        }
    },
})

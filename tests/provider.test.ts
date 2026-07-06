import './init.test.ts'

import { assertEquals } from '@std/assert'
import { LOCAL_DEFAULT } from '../src/scripts/defaults.ts'
import { getRemoteProvider, gistProvider } from '../src/scripts/features/synchronization/provider.ts'

import type { Local } from '../src/types/local.ts'

function makeLocal(overrides: Partial<Local> = {}): Local {
    const local = structuredClone(LOCAL_DEFAULT)
    Object.assign(local, overrides)
    return local
}

Deno.test('getRemoteProvider returns the selected provider only for remote sync types', () => {
    assertEquals(getRemoteProvider(makeLocal({ syncType: 'gist' }))?.kind, 'gist')
    assertEquals(getRemoteProvider(makeLocal({ syncType: 'off' })), undefined)
})

Deno.test('gistProvider uses generic remote sync fields', () => {
    const local = makeLocal({
        syncType: 'gist',
        gistToken: 'token',
        remoteResourceId: 'abc123',
        remoteLastSyncedAt: '2026-01-01T00:00:00.000Z',
        remoteLastFetchedAt: '2026-01-01T00:01:00.000Z',
    })

    assertEquals(gistProvider.isEnabled(local), true)
    assertEquals(gistProvider.isAuthorized(local), true)
    assertEquals(gistProvider.getResourceId(local), 'abc123')
    assertEquals(gistProvider.getLastSyncedAt(local), '2026-01-01T00:00:00.000Z')
    assertEquals(gistProvider.getLastFetchedAt(local), '2026-01-01T00:01:00.000Z')
})

Deno.test('gistProvider patches do not write legacy gist sync fields', () => {
    const metadata = {
        provider: 'gist' as const,
        resourceId: 'abc123',
        updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const synced = gistProvider.syncedPatch(metadata)
    const fetched = gistProvider.fetchedPatch('2026-01-01T00:01:00.000Z')

    assertEquals(synced, {
        remoteResourceId: 'abc123',
        remoteLastSyncedAt: '2026-01-01T00:00:00.000Z',
        localConfigUpdatedAt: '2026-01-01T00:00:00.000Z',
    })
    assertEquals(fetched, {
        remoteLastFetchedAt: '2026-01-01T00:01:00.000Z',
    })
    assertEquals(gistProvider.clearPatch(), [
        'remoteResourceId',
        'remoteLastSyncedAt',
        'remoteLastFetchedAt',
        'lastSyncedPayload',
    ])
})

Deno.test('LOCAL_DEFAULT does not contain legacy gist sync fields', () => {
    const local = LOCAL_DEFAULT as unknown as Record<string, unknown>

    assertEquals('gistId' in local, false)
    assertEquals('gistLastSyncedAt' in local, false)
    assertEquals('gistLastFetchedAt' in local, false)
    assertEquals('remoteResourceId' in local, true)
    assertEquals('remoteLastSyncedAt' in local, true)
    assertEquals('remoteLastFetchedAt' in local, true)
    assertEquals('lastSyncedPayload' in local, true)
})

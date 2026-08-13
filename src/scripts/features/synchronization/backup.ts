import { buildBookmarkSnapshotFromConfig, replaceBookmarksFromConfig } from '../links/bookmarks.ts'
import { syncWithBookmarks } from '../links/model.ts'
import { assertValidNormalizedSync } from './validation.ts'
import { withCrossContextSynchronizationLock } from './lock.ts'
import { flushPendingDebounces } from '../../utils/debounce.ts'
import { storage } from '../../storage.ts'

import type { Sync, SyncSnapshot } from '../../../types/sync.ts'

export interface ConfigSnapshot {
    timestamp: string
    reason: string
    config: SyncSnapshot
}

// `storage.clearall()` deliberately preserves the `bonjourr-archive-` prefix.
// Recovery points must survive a settings reset so they remain useful when a
// destructive restore is interrupted or later turns out to be unwanted.
const SNAPSHOTS_KEY = 'bonjourr-archive-config-snapshots'
const MAX_SNAPSHOTS = 3

/**
 * Persist a recovery point before an operation overwrites bookmarks or config.
 * Destructive operations must stop when this durable backup cannot be written.
 */
export async function saveConfigSnapshot(config: Sync, reason: string): Promise<void> {
    const snapshot = globalThis.chrome?.bookmarks
        ? await buildBookmarkSnapshotFromConfig(config)
        : syncWithBookmarks(structuredClone(config))
    await persistConfigSnapshot(snapshot, reason)
}

/** Persist an already-complete remote snapshot before intentionally replacing it. */
export async function saveExternalConfigSnapshot(config: SyncSnapshot, reason: string): Promise<void> {
    await persistConfigSnapshot(structuredClone(config), reason)
}

async function persistConfigSnapshot(snapshot: SyncSnapshot, reason: string): Promise<void> {
    const snapshots = await getConfigSnapshots()
    snapshots.unshift({
        timestamp: new Date().toISOString(),
        reason,
        config: snapshot,
    })
    snapshots.splice(MAX_SNAPSHOTS)
    await storage.archive.set(SNAPSHOTS_KEY, snapshots)
}

export async function getConfigSnapshots(): Promise<ConfigSnapshot[]> {
    const parsed = await storage.archive.get<unknown>(SNAPSHOTS_KEY)
    if (!Array.isArray(parsed)) return []

    return parsed.filter((entry): entry is ConfigSnapshot => {
        if (!entry || typeof entry !== 'object') return false
        const value = entry as Partial<ConfigSnapshot>
        return typeof value.timestamp === 'string' && typeof value.reason === 'string' &&
            !!value.config && typeof value.config === 'object'
    })
}

export async function restoreConfigSnapshot(index: number): Promise<boolean> {
    const target = (await getConfigSnapshots())[index]
    if (!target) return false

    await withCrossContextSynchronizationLock(async () => {
        assertValidNormalizedSync(target.config)
        await flushPendingDebounces()
        await storage.flushWrites()
        await storage.runExclusive(async (syncAccess) => {
            const current = await syncAccess.get()
            const currentSnapshot = globalThis.chrome?.bookmarks
                ? await buildBookmarkSnapshotFromConfig(current)
                : syncWithBookmarks(structuredClone(current))
            await saveExternalConfigSnapshot(currentSnapshot, 'before-snapshot-restore')
            storage.stageSyncForReload(target.config)

            try {
                if (globalThis.chrome?.bookmarks) {
                    await replaceBookmarksFromConfig(currentSnapshot, target.config)
                }
                await syncAccess.replace(target.config)
                storage.clearStagedSyncForReload()
            } catch (error) {
                try {
                    storage.stageSyncForReload(current)
                    if (globalThis.chrome?.bookmarks) {
                        await replaceBookmarksFromConfig(target.config, currentSnapshot)
                    }
                    await syncAccess.replace(current)
                    storage.clearStagedSyncForReload()
                } catch (rollbackError) {
                    throw new AggregateError([
                        error,
                        rollbackError,
                    ], 'Snapshot restore and automatic rollback both failed')
                }
                throw error
            }
            globalThis.dispatchEvent(new Event('bonjourr-sync-write'))
        })
    })
    return true
}

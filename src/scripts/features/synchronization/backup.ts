import { replaceBookmarksFromConfig } from '../links/bookmarks.ts'
import { storage } from '../../storage.ts'
import { fadeOut } from '../../shared/dom.ts'

import type { Sync } from '../../../types/sync.ts'

export interface ConfigSnapshot {
    timestamp: string
    reason: string
    config: Sync
}

const SNAPSHOTS_KEY = 'bonjourr-config-snapshots'
const MAX_SNAPSHOTS = 3
const MAX_STORAGE_BYTES = 2_000_000

export function saveConfigSnapshot(config: Sync, reason: string): void {
    try {
        const snapshots = getConfigSnapshots()
        const entry: ConfigSnapshot = {
            timestamp: new Date().toISOString(),
            reason,
            config: structuredClone(config),
        }

        snapshots.unshift(entry)

        while (snapshots.length > MAX_SNAPSHOTS) {
            snapshots.pop()
        }

        const serialized = JSON.stringify(snapshots)

        if (serialized.length > MAX_STORAGE_BYTES) {
            snapshots.pop()
            const retry = JSON.stringify(snapshots)
            if (retry.length > MAX_STORAGE_BYTES) {
                return
            }
            localStorage.setItem(SNAPSHOTS_KEY, retry)
            return
        }

        localStorage.setItem(SNAPSHOTS_KEY, serialized)
    } catch (_) {
        // localStorage full or unavailable — backup is best-effort
    }
}

export function getConfigSnapshots(): ConfigSnapshot[] {
    try {
        const raw = localStorage.getItem(SNAPSHOTS_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed
    } catch (_) {
        return []
    }
}

export async function restoreConfigSnapshot(index: number): Promise<boolean> {
    const snapshots = getConfigSnapshots()
    const target = snapshots[index]

    if (!target) {
        return false
    }

    const current = await storage.sync.get()
    saveConfigSnapshot(current, 'before-restore')

    // Push the snapshot's bookmark state into Chrome before storage.sync is
    // overwritten. Without this, page-reload's initBookmarkSync would mirror
    // Chrome's *current* (un-restored) bookmarks back into data.links and
    // silently undo the bookmark portion of the restore.
    await replaceBookmarksFromConfig(current, target.config)

    await storage.sync.clear()
    await storage.sync.set(target.config)
    fadeOut()
    return true
}

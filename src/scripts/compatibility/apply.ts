import { CURRENT_VERSION, PLATFORM, SYNC_DEFAULT } from '../defaults.ts'
import { normalizeLinksState } from '../features/links/model.ts'
import { deepmergeAll } from '@victr/deepmerge'
import type { Sync } from '../../types/sync.ts'

/**
 * Merges an imported partial Sync into the given current Sync. If the import
 * already contains every top-level Sync key, it is treated as a full config and
 * replaces current entirely; otherwise the two are deep-merged.
 */
export function mergeImportedConfig(current: Sync, target: Partial<Sync>): Sync {
    const requiredKeys = Object.keys(SYNC_DEFAULT) as (keyof Sync)[]
    const isFullConfig = requiredKeys.every((key) => key in target)

    const merged: Sync = isFullConfig ? (target as Sync) : (deepmergeAll(current, target) as Sync)

    merged.about = {
        browser: PLATFORM,
        version: CURRENT_VERSION,
    }

    normalizeLinksState(merged as Sync & Record<string, unknown>)

    return merged
}

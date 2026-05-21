import { SYNC_DEFAULT } from '../defaults.ts'
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

    normalizeLinksState(merged as Sync & Record<string, unknown>)
    removeDeprecatedFields(merged)

    return merged
}

function removeDeprecatedFields(data: Sync): void {
    delete (data.clock as unknown as Record<string, unknown>).analog
    delete (data.backgrounds as unknown as Record<string, unknown>).mute
    delete (data.backgrounds as unknown as Record<string, unknown>).fadein

    const images = [data.backgrounds.pausedImage, ...Object.values(data.backgrounds.queries).flat()]
    for (const img of images) {
        if (img && typeof img === 'object' && 'exif' in img) {
            delete (img as Record<string, unknown>).exif
        }
    }
}

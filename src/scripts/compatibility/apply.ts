import { SYNC_DEFAULT } from '../defaults.ts'
import { normalizeLinksState } from '../features/links/model.ts'
import { deepmergeAll } from '@victr/deepmerge'
import type { Backgrounds, Sync } from '../../types/sync.ts'

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
    normalizeImportedBackgroundTexture(merged, target)

    return merged
}

function normalizeImportedBackgroundTexture(data: Sync, target: Partial<Sync>): void {
    const incomingBackgrounds = target.backgrounds as Partial<Backgrounds> | undefined
    const incomingTexture = incomingBackgrounds?.texture as Partial<Backgrounds['texture']> | undefined

    if (!data.backgrounds.texture) {
        data.backgrounds.texture = structuredClone(SYNC_DEFAULT.backgrounds.texture)
    }

    if (incomingBackgrounds && data.backgrounds.type !== 'color' && typeof incomingTexture?.type !== 'string') {
        data.backgrounds.texture = { type: 'none' }
    }
}

function removeDeprecatedFields(data: Sync): void {
    delete (data.clock as unknown as Record<string, unknown>).analog
    delete (data.backgrounds as unknown as Record<string, unknown>).mute
    delete (data.backgrounds as unknown as Record<string, unknown>).fadein
    data.backgrounds.queries ??= {}

    if (data.backgrounds.pausedImage) {
        data.backgrounds.type = 'images'
        data.backgrounds.frequency = 'pause'
        delete data.backgrounds.pausedUrl
    } else if (data.backgrounds.pausedUrl) {
        data.backgrounds.type = 'urls'
        data.backgrounds.frequency = 'pause'
        delete data.backgrounds.pausedImage
    } else if (data.backgrounds.frequency !== 'pause') {
        delete data.backgrounds.pausedImage
        delete data.backgrounds.pausedUrl
    }

    const images = [data.backgrounds.pausedImage, ...Object.values(data.backgrounds.queries).flat()]
    for (const img of images) {
        if (img && typeof img === 'object' && 'exif' in img) {
            delete (img as Record<string, unknown>).exif
        }
    }
}

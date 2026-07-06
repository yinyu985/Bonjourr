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

    if (!incomingBackgrounds || data.backgrounds.type === 'color') {
        return
    }

    // 当远程配置的 texture 缺省或等于 SYNC_DEFAULT 的默认 topographic 时，
    // 认为纹理不是用户有意设置的（导出时捎带的默认值），对于非纯色背景用 'none' 覆盖。
    // 这样即使远程 JSON 携带了 `texture: {type:'topographic', ...}`，
    // 下载到图片/锁定背景时不会错误地继承默认花纹。
    const incomingHasExplicitTexture = typeof incomingTexture?.type === 'string' &&
        incomingTexture.type !== SYNC_DEFAULT.backgrounds.texture.type

    if (!incomingHasExplicitTexture) {
        data.backgrounds.texture = { type: 'none' }
    }
}

function removeDeprecatedFields(data: Sync): void {
    delete (data.clock as unknown as Record<string, unknown>).analog
    delete (data.backgrounds as unknown as Record<string, unknown>).mute
    delete (data.backgrounds as unknown as Record<string, unknown>).fadein
    delete (data.backgrounds as unknown as Record<string, unknown>).queries

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

    const images = [data.backgrounds.pausedImage]
    for (const img of images) {
        if (img && typeof img === 'object' && 'exif' in img) {
            delete (img as Record<string, unknown>).exif
        }
    }
}

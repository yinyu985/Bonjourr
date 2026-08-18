import { SYNC_DEFAULT } from '../defaults.ts'
import { normalizeLinksState } from '../features/links/model.ts'
import type { Backgrounds, Sync } from '../../types/sync.ts'

/**
 * Merges an imported partial Sync into the given current Sync. If the import
 * already contains every top-level Sync key, it is treated as a full config and
 * replaces current entirely; otherwise the two are deep-merged.
 */
export function mergeImportedConfig(current: Sync, target: Partial<Sync>): Sync {
    const requiredKeys = Object.keys(SYNC_DEFAULT) as (keyof Sync)[]
    const isFullConfig = requiredKeys.every((key) => key in target)

    const merged = isFullConfig ? structuredClone(target as Sync) : deepMergeConfig(current, target)

    normalizeLinksState(merged as Sync & Record<string, unknown>)
    removeDeprecatedFields(merged)
    normalizeImportedBackgroundTexture(merged, target)

    return merged
}

function deepMergeConfig(current: Sync, target: Partial<Sync>): Sync {
    return mergeValue(current, target) as Sync
}

function mergeValue(current: unknown, target: unknown): unknown {
    if (Array.isArray(target)) {
        const next = structuredClone(target)
        return Array.isArray(current) ? [...structuredClone(current), ...next] : next
    }
    if (!isRecord(target)) {
        return structuredClone(target)
    }

    const result: Record<string, unknown> = isRecord(current) ? structuredClone(current) : {}
    for (const [key, value] of Object.entries(target)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
        result[key] = key in result ? mergeValue(result[key], value) : structuredClone(value)
    }
    return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
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

/**
 * Strips fields that existed in older schemas but are no longer part of the
 * current one, and coerces retired background sources. Must run before any
 * validation so that legacy remote/imported configs migrate instead of being
 * rejected. Defensive against partial inputs.
 */
export function removeDeprecatedFields(data: Sync): void {
    const root = data as Record<string, unknown>
    delete root.showall

    if (isRecord(data.clock)) {
        delete (data.clock as unknown as Record<string, unknown>).analog
    }

    const backgrounds = data.backgrounds as unknown as Record<string, unknown> | undefined
    if (!isRecord(backgrounds)) return

    delete backgrounds.mute
    delete backgrounds.fadein
    delete backgrounds.queries
    delete backgrounds.urls
    delete backgrounds.pausedUrl

    // The "files" and "urls" background sources were removed from this fork.
    // Imported configs that used them fall back to the solid color.
    if (backgrounds.type === 'files' || backgrounds.type === 'urls') {
        backgrounds.type = 'color'
        backgrounds.frequency = 'hour'
    }

    if (isRecord(backgrounds.pausedImage)) {
        backgrounds.type = 'images'
        backgrounds.frequency = 'pause'
        if ('exif' in backgrounds.pausedImage) {
            delete (backgrounds.pausedImage as Record<string, unknown>).exif
        }
    } else if (backgrounds.frequency !== 'pause') {
        delete backgrounds.pausedImage
    }
}

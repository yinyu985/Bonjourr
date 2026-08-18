import { storage } from '../../storage.ts'
import { settingsBackgroundColor } from '../others.ts'
import { TEXTURE_RANGES } from './textures.ts'

import type { Backgrounds } from '../../../types/sync.ts'

const BACKGROUND_CACHE_KEY = 'backgroundCache'
const BACKGROUND_PRELOAD_KEY = 'backgroundPreloadingAt'
let backgroundRuntimeVersion = 0

export function currentBackgroundRuntimeVersion(): number {
    return backgroundRuntimeVersion
}

export function isCurrentBackgroundRuntimeVersion(version: number): boolean {
    return version === backgroundRuntimeVersion
}

export function invalidateBackgroundRuntime(): void {
    backgroundRuntimeVersion += 1
}

export async function resetBackgroundRuntimeCache(backgrounds?: Backgrounds): Promise<void> {
    invalidateBackgroundRuntime()
    localStorage.removeItem(BACKGROUND_CACHE_KEY)
    localStorage.removeItem(BACKGROUND_PRELOAD_KEY)
    resetBackgroundDom(backgrounds)
    restoreLockedBackgroundCache(backgrounds)

    await storage.local.remove('backgroundCollections')
    await storage.local.remove('backgroundLastChange')
}

function restoreLockedBackgroundCache(backgrounds?: Backgrounds): void {
    if (backgrounds?.type === 'images' && backgrounds.frequency === 'pause' && backgrounds.pausedImage) {
        localStorage.setItem(BACKGROUND_CACHE_KEY, backgrounds.pausedImage.urls.full)
    }
}

function resetBackgroundDom(backgrounds?: Backgrounds): void {
    const wrapper = document.getElementById('background-wrapper')
    const media = document.getElementById('background-media')

    Array.from(media?.children ?? []).forEach((node) => {
        const objectUrl = (node as HTMLElement).dataset.objectUrl
        if (objectUrl) {
            URL.revokeObjectURL(objectUrl)
        }
        node.remove()
    })

    if (!backgrounds) {
        return
    }

    wrapper?.setAttribute('data-type', backgrounds.type)
    applyCachedTexture(backgrounds.texture)

    if (backgrounds.type === 'images' && backgrounds.frequency === 'pause' && backgrounds.pausedImage) {
        showCachedImageBackground(backgrounds.pausedImage.urls.full, backgrounds.pausedImage.color)
        return
    }

    if (backgrounds.type !== 'color') {
        return
    }

    wrapper?.classList.remove('hidden')
    document.documentElement.style.setProperty('--solid-background', backgrounds.color)
    document.documentElement.style.setProperty('--average-color', backgrounds.color)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', backgrounds.color)
    settingsBackgroundColor(backgrounds.color)
}

function applyCachedTexture(texture?: Backgrounds['texture']): void {
    const wrapper = document.getElementById('background-wrapper')

    if (!wrapper) {
        return
    }

    const type = texture?.type ?? 'none'
    const ranges = TEXTURE_RANGES[type]
    const color = texture?.color ?? ranges.color
    const size = texture?.size ?? ranges.size.value
    const opacity = texture?.opacity ?? ranges.opacity.value

    wrapper.dataset.texture = type
    document.documentElement.style.setProperty('--texture-color', `${color}`)
    document.documentElement.style.setProperty('--texture-color-transparent', `${color}77`)
    document.documentElement.style.setProperty('--texture-opacity', `${opacity}`)
    document.documentElement.style.setProperty('--texture-size', `${size}px`)
}

function showCachedImageBackground(src: string, color?: string): void {
    const wrapper = document.getElementById('background-wrapper')
    const media = document.getElementById('background-media')
    const image = document.createElement('div')

    image.className = 'background-image'
    image.style.backgroundImage = `url(${src})`
    media?.prepend(image)
    wrapper?.classList.remove('hidden')

    if (color) {
        document.documentElement.style.setProperty('--average-color', color)
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
        settingsBackgroundColor(color)
    }
}

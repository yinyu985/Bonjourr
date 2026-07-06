import type { Backgrounds } from '../../../types/sync.ts'

export type BackgroundPatch = Partial<Omit<Backgrounds, 'texture'>> & {
    texture?: Partial<Backgrounds['texture']>
}

export function queryCollectionName(targetId: string, backgrounds: Backgrounds): string {
    switch (targetId) {
        case 'f_background-user-search':
        case 'i_background-user-search':
            return 'unsplash-images-search'
        case 'f_background-user-coll':
        case 'i_background-user-coll':
            return 'unsplash-images-collections'
        default:
            return selectedBackgroundSource(backgrounds)
    }
}

export function backgroundQueryValue(backgrounds: Backgrounds, collectionName: string): string {
    const customProvider = collectionName === 'unsplash-images-search' ||
        collectionName === 'unsplash-images-collections'

    return customProvider ? backgrounds.query : ''
}

export function backgroundSourcePatch(type: Backgrounds['type'], value: string): BackgroundPatch {
    switch (type) {
        case 'images':
            return { images: value }
        case 'urls':
            return { urls: value }
        default:
            return {}
    }
}

export function mergeBackgroundPatch(current: Backgrounds, patch: BackgroundPatch): Backgrounds {
    return {
        ...current,
        ...patch,
        texture: {
            ...current.texture,
            ...patch.texture,
        },
    }
}

function selectedBackgroundSource(backgrounds: Backgrounds): string {
    switch (backgrounds.type) {
        case 'images':
            return backgrounds.images
        case 'urls':
            return backgrounds.urls
        default:
            return ''
    }
}

import type { LinkIcon } from '../../types/shared.ts'
import type { Sync } from '../../types/sync.ts'

export type LegacyLink = LegacyLinkElem | LegacyLinkFolder

export interface LegacyLinkElem {
    _id: string
    parent?: string | number
    folder?: false
    order: number
    title: string
    url: string
    icon?: LinkIcon | string
    bookmark?: {
        id: string
        parentId?: string
    }
}

export interface LegacyLinkFolder {
    _id: string
    parent?: string | number
    folder: true
    order: number
    title: string
}

export function bundleLinks(data: Partial<Sync> | Record<string, unknown>): LegacyLink[] {
    const res: LegacyLink[] = []

    Object.entries(data).map(([key, val]) => {
        if (key.length === 11 && key.startsWith('links')) {
            res.push(val as LegacyLink)
        }
    })

    return res
}

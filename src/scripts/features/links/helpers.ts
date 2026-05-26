import { stringMaxSize } from '../../shared/generic.ts'
import { tradThis } from '../../utils/translations.ts'
export {
    getFolder,
    getFolderByTitle,
    getLink,
    getLinksInSubfolder,
    getNode,
    getSubfolder,
    isElem,
    isLink,
    isSubfolder,
} from './model.ts'

import { isElem } from './model.ts'

import type { LinkNode } from '../../../types/shared.ts'

export const DEFAULT_FAVICON = 'src/assets/interface/default-favicon.png'
export const FOLDER_ICON = 'src/assets/interface/folder.svg'

export function getDefaultIcon(url: string, refresh?: number): string {
    return getRemoteFaviconUrl(url, refresh) ?? DEFAULT_FAVICON
}

export function getRemoteFaviconUrl(url: string, refresh?: number): string | undefined {
    try {
        const host = new URL(url).hostname
        if (!host) return undefined
        const base = `https://icons.duckduckgo.com/ip3/${host}.ico`
        return refresh ? `${base}?r=${refresh}` : base
    } catch (_) {
        return undefined
    }
}

export function getSelectedIds(): string[] {
    const selected = document.querySelectorAll<HTMLLIElement>('li.selected')
    return Object.values(selected).map((li) => li.id)
}

export function getLiFromEvent(event: Event): HTMLLIElement | undefined {
    const path = event.composedPath() as Element[]
    const li = path.find((el) => el.tagName === 'LI' && el.className?.includes('link'))

    if (li) {
        return li as HTMLLIElement
    }
}

export function getTitleFromEvent(event: Event): HTMLElement | undefined {
    const path = event.composedPath() as Element[]
    const title = path.find((el) => el.className?.includes('link-title'))

    if (title) {
        return title as HTMLElement
    }
}

export function createTitle(link: LinkNode): string {
    const isInline = document.getElementById('linkblocks')?.className.includes('inline')
    const isText = document.getElementById('linkblocks')?.className.includes('text')

    if (!(isInline || isText) || link?.title !== '') {
        return stringMaxSize(link.title ?? '', 64)
    }

    // For inline/text styles with empty title, show hostname as display fallback
    // without mutating the stored title (so empty titles are preserved)
    try {
        if (isElem(link)) {
            return new URL(link.url)?.hostname.replace('www.', '')
        } else {
            return tradThis('folder')
        }
    } catch (_) {
        //
    }

    return ''
}

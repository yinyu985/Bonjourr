import { stringMaxSize } from '../../shared/generic.ts'
import { API_DOMAIN } from '../../defaults.ts'
import { tradThis } from '../../utils/translations.ts'
export {
    getFolder,
    getFolderByBookmarkSource,
    getFolderByTitle,
    getLink,
    getLinksInFolder,
    getLinksInSubfolder,
    getNode,
    getSubfolder,
    isElem,
    isLink,
    isSubfolder,
} from './model.ts'

import { isElem } from './model.ts'

import type { LinkIconType, LinkNode } from '../../../types/shared.ts'

export function getDefaultIcon(url: string, refresh?: number): string {
    if (refresh) {
        return `${API_DOMAIN}/favicon/blob/${url}?r=${refresh}`
    }

    return `${API_DOMAIN}/favicon/blob/${url}`
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

export function isLinkIconType(type: string): type is LinkIconType {
    return ['auto', 'library', 'file', 'url'].includes(type)
}

// to figure out if a string is a valid number
export function isNumber(value: string): boolean {
    return !isNaN(parseFloat(value))
}

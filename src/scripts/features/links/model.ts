import { randomString, stringMaxSize } from '../../shared/generic.ts'

import type { LinkElem, LinkNode, LinkSubfolder } from '../../../types/shared.ts'
import type { BookmarkLinksState, LinkFolder, LinksState, Sync, SyncSnapshot } from '../../../types/sync.ts'

export const FAVORITES_FOLDER = '__favorites'

export type LinkLocation = {
    node: LinkNode
    items: LinkNode[]
    folder: LinkFolder
    subfolder?: LinkSubfolder
    index: number
}

export function linksWithBookmarks(sync: Sync): BookmarkLinksState {
    const links = sync.links as LinksState & Partial<BookmarkLinksState>
    return {
        ...links,
        folders: Array.isArray(links.folders) ? links.folders : [],
        favorites: Array.isArray(links.favorites) ? links.favorites.filter(isElem) : [],
    }
}

export function syncWithBookmarks(sync: Sync): SyncSnapshot {
    return {
        ...sync,
        links: linksWithBookmarks(sync),
    }
}

export function normalizeLinksState(data: Partial<Sync>): LinksState {
    if (isLinksState(data.links)) {
        data.links = normalizeCurrentLinks(data.links)
        return data.links
    }

    data.links = normalizeCurrentLinks({
        enabled: true,
        foldersOn: false,
        selectedFolder: '',
        rows: 16,
        iconRadius: 0,
        style: 'text',
        newTab: true,
        titles: false,
        backgrounds: true,
    })

    return data.links
}

export function newLinkId(): string {
    return `links${randomString(6)}`
}

export function newFolderId(): string {
    return `folder${randomString(6)}`
}

export function createLink(title: string, url: string, id?: string): LinkElem {
    return {
        id: id ?? newLinkId(),
        title: stringMaxSize(title, 64),
        url,
    }
}

export function createSubfolder(title: string, items: LinkNode[] = []): LinkSubfolder {
    return {
        id: newLinkId(),
        title: stringMaxSize(title, 64),
        items,
    }
}

export function getFolder(data: Sync, id?: string): LinkFolder | undefined {
    return linksWithBookmarks(data).folders.find((folder) => folder.id === id)
}

export function getFolderByTitle(data: Sync, title: string): LinkFolder | undefined {
    return linksWithBookmarks(data).folders.find((folder) => folder.title === title)
}

export function getNode(data: Sync, id: string): LinkNode | undefined {
    return findNode(data, id)?.node
}

export function getLink(data: Sync, id: string): LinkElem | undefined {
    const node = getNode(data, id)
    return isElem(node) ? node : undefined
}

export function getSubfolder(data: Sync, id: string): LinkSubfolder | undefined {
    const node = getNode(data, id)
    return isSubfolder(node) ? node : undefined
}

export function findNode(data: Sync, id: string): LinkLocation | undefined {
    const links = linksWithBookmarks(data)

    for (const folder of links.folders) {
        const found = findNodeInItems(folder.items, id, folder)
        if (found) return found
    }

    const favoriteIndex = links.favorites.findIndex((link) => link.id === id)
    const favorite = links.favorites[favoriteIndex]
    if (favorite) {
        return {
            node: favorite,
            items: links.favorites,
            folder: favoritesFolder(),
            index: favoriteIndex,
        }
    }
}

export function getLinksInSubfolder(data: Sync, id: string): LinkNode[] {
    return getSubfolder(data, id)?.items ?? []
}

export function allNodes(data: Sync): LinkNode[] {
    const links = linksWithBookmarks(data)
    return [...links.folders.flatMap((folder) => flattenNodes(folder.items)), ...links.favorites]
}

export function allLinks(data: Sync): LinkElem[] {
    return allNodes(data).filter(isElem)
}

export function removeNode(data: Sync, id: string): LinkNode | undefined {
    const found = findNode(data, id)
    if (!found) return

    const [removed] = found.items.splice(found.index, 1)
    return removed
}

export function removeFolder(data: Sync, id: string): LinkFolder | undefined {
    const links = linksWithBookmarks(data)
    const index = links.folders.findIndex((folder) => folder.id === id)
    if (index < 0) return

    const [removed] = links.folders.splice(index, 1)
    if (data.links.selectedFolder === id) {
        data.links.selectedFolder = links.folders[0]?.id ?? ''
    }
    return removed
}

export function isElem(link: unknown): link is LinkElem {
    const value = link as LinkElem | LinkSubfolder | undefined
    return !!value &&
        typeof value.id === 'string' &&
        typeof value.title === 'string' &&
        typeof (value as LinkElem).url === 'string' &&
        !isSubfolder(value)
}

export function isSubfolder(link: unknown): link is LinkSubfolder {
    const value = link as LinkSubfolder | undefined
    return !!value && typeof value.id === 'string' && typeof value.title === 'string' && Array.isArray(value.items)
}

export function isLink(link: unknown): link is LinkNode {
    return isElem(link) || isSubfolder(link)
}

function normalizeCurrentLinks(links: LinksState): LinksState {
    const withBookmarks = links as LinksState & Partial<BookmarkLinksState>
    const folders = Array.isArray(withBookmarks.folders) ? withBookmarks.folders : []

    if (Array.isArray(withBookmarks.favorites)) {
        withBookmarks.favorites = withBookmarks.favorites.filter(isElem)
    }

    for (const folder of folders) {
        folder.id ||= newFolderId()
        folder.title ||= folder.id
        folder.items = normalizeItems(folder.items)
    }

    if (!folders.some((folder) => folder.id === links.selectedFolder)) {
        links.selectedFolder = folders[0]?.id ?? ''
    }

    links.style = links.style === 'inline' || links.style === 'text' ? links.style : 'text'
    links.rows ??= 16
    links.iconRadius ??= 0
    links.enabled ??= true
    links.foldersOn ??= false
    links.newTab ??= true
    links.titles ??= false
    links.backgrounds ??= true

    return links
}

function normalizeItems(items: LinkNode[] = []): LinkNode[] {
    return items.filter(isLink).map((node) => {
        if (isSubfolder(node)) {
            node.items = normalizeItems(node.items)
        }
        return node
    })
}

function isLinksState(value: unknown): value is LinksState {
    const links = value as LinksState | undefined
    return !!links && typeof links === 'object'
}

function findNodeInItems(
    items: LinkNode[],
    id: string,
    folder: LinkFolder,
    subfolder?: LinkSubfolder,
): LinkLocation | undefined {
    for (let i = 0; i < items.length; i++) {
        const node = items[i]

        if (node.id === id) {
            return { node, items, folder, subfolder, index: i }
        }

        if (isSubfolder(node)) {
            const found = findNodeInItems(node.items, id, folder, node)
            if (found) return found
        }
    }
}

function flattenNodes(items: LinkNode[]): LinkNode[] {
    return items.flatMap((item) => isSubfolder(item) ? [item, ...flattenNodes(item.items)] : [item])
}

function favoritesFolder(): LinkFolder {
    return {
        id: FAVORITES_FOLDER,
        title: FAVORITES_FOLDER,
        items: [],
    }
}

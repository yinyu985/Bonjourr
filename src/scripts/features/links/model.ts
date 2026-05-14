import { randomString, stringMaxSize } from '../../shared/generic.ts'

import type { LinkElem, LinkNode, LinkSubfolder } from '../../../types/shared.ts'
import type { LinkFolder, LinkFolderSource, LinksState, Sync } from '../../../types/sync.ts'

export const FAVORITES_FOLDER = '__favorites'

export type LinkLocation = {
    node: LinkNode
    items: LinkNode[]
    folder: LinkFolder
    subfolder?: LinkSubfolder
    index: number
}

export function normalizeLinksState(data: Partial<Sync>): LinksState {
    if (isLinksState(data.links)) {
        data.links = normalizeCurrentLinks(data.links)
        return data.links
    }

    data.links = normalizeCurrentLinks({
        enabled: true,
        foldersOn: false,
        selectedFolder: 'default',
        rows: 16,
        iconRadius: 0,
        style: 'text',
        newTab: true,
        titles: false,
        backgrounds: true,
        folders: [{
            id: 'default',
            title: 'default',
            source: 'local',
            items: [],
        }],
        favorites: [],
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

export function createSubfolder(title: string, items: LinkElem[] = []): LinkSubfolder {
    return {
        id: newLinkId(),
        title: stringMaxSize(title, 64),
        items,
    }
}

export function getFolder(data: Sync, id?: string): LinkFolder | undefined {
    return data.links.folders.find((folder) => folder.id === id)
}

export function getFolderByTitle(data: Sync, title: string): LinkFolder | undefined {
    return data.links.folders.find((folder) => folder.title === title)
}

export function getFolderByBookmarkSource(data: Sync, folderId: string): LinkFolder | undefined {
    return data.links.folders.find((folder) => folder.source === 'bookmarks' && folder.id === folderId)
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
    for (const folder of data.links.folders) {
        const found = findNodeInItems(folder.items, id, folder)
        if (found) return found
    }

    const favoriteIndex = data.links.favorites.findIndex((link) => link.id === id)
    const favorite = data.links.favorites[favoriteIndex]
    if (favorite) {
        return {
            node: favorite,
            items: data.links.favorites,
            folder: favoritesFolder(),
            index: favoriteIndex,
        }
    }
}

export function getLinksInSubfolder(data: Sync, id: string): LinkElem[] {
    return getSubfolder(data, id)?.items ?? []
}

export function allNodes(data: Sync): LinkNode[] {
    return [...data.links.folders.flatMap((folder) => flattenNodes(folder.items)), ...data.links.favorites]
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
    const index = data.links.folders.findIndex((folder) => folder.id === id)
    if (index < 0) return

    const [removed] = data.links.folders.splice(index, 1)
    if (data.links.selectedFolder === id) {
        data.links.selectedFolder = data.links.folders[0]?.id ?? 'default'
    }
    return removed
}

export function isElem(link: unknown): link is LinkElem {
    const value = link as LinkElem | LinkSubfolder | undefined
    return !!value && typeof value.id === 'string' && typeof value.title === 'string' && !isSubfolder(value)
}

export function isSubfolder(link: unknown): link is LinkSubfolder {
    const value = link as LinkSubfolder | undefined
    return !!value && typeof value.id === 'string' && typeof value.title === 'string' && Array.isArray(value.items)
}

export function isLink(link: unknown): link is LinkNode {
    return isElem(link) || isSubfolder(link)
}

function normalizeCurrentLinks(links: LinksState): LinksState {
    links.folders = Array.isArray(links.folders) ? links.folders : []
    links.favorites = Array.isArray(links.favorites) ? links.favorites.filter(isElem) : []

    for (const folder of links.folders) {
        folder.id ||= newFolderId()
        folder.title ||= 'default'
        folder.source = normalizeFolderSource(folder.source)
        folder.items = normalizeItems(folder.items)
    }

    if (links.folders.length === 0) {
        links.folders.push({
            id: 'default',
            title: 'default',
            source: 'local',
            items: [],
        })
    }

    if (!links.folders.some((folder) => folder.id === links.selectedFolder)) {
        links.selectedFolder = links.folders[0].id
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
            node.items = normalizeItems(node.items).filter(isElem)
        }
        return node
    })
}

function isLinksState(value: unknown): value is LinksState {
    const links = value as LinksState | undefined
    return !!links && Array.isArray(links.folders) && Array.isArray(links.favorites)
}

function isFolderSource(source: unknown): source is LinkFolderSource {
    return source === 'local' || source === 'bookmarks'
}

function normalizeFolderSource(source: unknown): LinkFolderSource {
    if (isFolderSource(source)) {
        return source
    }

    return 'local'
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
    return items.flatMap((item) => isSubfolder(item) ? [item, ...item.items] : [item])
}

function favoritesFolder(): LinkFolder {
    return {
        id: FAVORITES_FOLDER,
        title: FAVORITES_FOLDER,
        source: 'bookmarks',
        items: [],
    }
}

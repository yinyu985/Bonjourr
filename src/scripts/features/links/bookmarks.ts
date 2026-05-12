import { initblocks, validateLink } from './index.ts'
import { initFolders } from './groups.ts'
import { isElem, isSubfolder } from './helpers.ts'
import { allLinks, FAVORITES_FOLDER, getFolderByBookmarkSource, getFolderByTitle, removeFolder } from './model.ts'

import { EXTENSION } from '../../defaults.ts'
import { tradThis } from '../../utils/translations.ts'
import { settingsNotifications } from '../../utils/notifications.ts'
import { getPermissions } from '../../utils/permissions.ts'
import { storage } from '../../storage.ts'

import type { LinkElem, LinkNode } from '../../../types/shared.ts'
import type { LinkFolder, Sync } from '../../../types/sync.ts'

type Treenode = browser.bookmarks.BookmarkTreeNode

type BookmarksFolder = {
    id: string
    title: string
    displayTitle?: string
    bookmarks: BookmarksFolderItem[]
}

type BookmarksFolderItem = {
    id: string
    parentId?: string
    index?: number
    title: string
    url: string
    dateAdded: number
}

type BookmarkLinksUpdate = {
    addLinks?: {
        title: string
        url: string
        folder?: string
        group?: string
        bookmarkId?: string
    }[]
    updateLink?: {
        id: string
        url?: string
        title: string
    }
    moveLinks?: string[]
    moveFavorites?: string[]
    moveToFolder?: {
        source?: string
        target: string
        ids?: string[]
    }
    moveToSubfolder?: {
        source: string
        target: string
    }
    moveOutSubfolder?: { ids: string[]; folder: string }
    deleteLinks?: string[]
    deleteFolder?: string
    folderTitle?: { old: string; new: string }
    moveFolders?: string[]
    unsyncFolder?: string
}

let browserBookmarkFolders: BookmarksFolder[] = []
let bookmarkListenerAdded = false
let bookmarkRestoreInProgress = false
let bookmarkRefreshQueued = false
let bookmarkRestoreReleaseTimer = 0

export async function linksImport(): Promise<void> {
    const data = await storage.sync.get()
    const refreshed = await initBookmarkSync(data)
    await renderLinksFromSync(refreshed)
}

export async function renderLinksFromSync(data: Sync): Promise<void> {
    if (!document.getElementById('linkblocks')) {
        return
    }

    const local = await storage.local.get()
    initFolders(data)
    initblocks(data, local)
}

export async function initBookmarkSync(data: Sync): Promise<Sync> {
    let treenode = await getBookmarkTree()

    if (!treenode) {
        try {
            await getPermissions('bookmarks')
            treenode = await getBookmarkTree()
        } catch (_error) {
            settingsNotifications({ 'accept-permissions': true })
        }
    }

    if (!treenode) {
        browserBookmarkFolders = []
        return data
    }

    browserBookmarkFolders = bookmarkTreeToFolderList(treenode[0])
    let mutated = applySyncedFolders(data)
    mutated = applyFavoritesFromToolbar(data) || mutated

    if (mutated) {
        await storage.sync.set(data)
    }

    addBookmarkListeners()
    return data
}

function applySyncedFolders(data: Sync): boolean {
    let mutated = false
    const syncedFolderIds: string[] = []
    const previousSynced = data.links.folders.filter((folder) => folder.source.type === 'bookmarks')

    for (const browserFolder of browserBookmarkFolders) {
        if (browserFolder.title === FAVORITES_FOLDER) {
            continue
        }

        let folder = getFolderByBookmarkSource(data, browserFolder.id)

        if (!folder) {
            folder = getFolderByTitle(data, browserFolder.title)
        }

        if (!folder) {
            folder = {
                id: `folder${browserFolder.id}`,
                title: browserFolder.title,
                pinned: false,
                source: { type: 'bookmarks', folderId: browserFolder.id },
                items: [],
            }
            data.links.folders.push(folder)
            mutated = true
        }

        if (folder.title !== browserFolder.title) {
            folder.title = browserFolder.title
            mutated = true
        }

        if (folder.source.type !== 'bookmarks' || folder.source.folderId !== browserFolder.id) {
            folder.source = { type: 'bookmarks', folderId: browserFolder.id }
            mutated = true
        }

        syncedFolderIds.push(folder.id)
        mutated = mirrorFolderIntoFolder(folder, browserFolder.bookmarks) || mutated
    }

    for (const folder of previousSynced) {
        if (!syncedFolderIds.includes(folder.id)) {
            removeFolder(data, folder.id)
            mutated = true
        }
    }

    const synced = data.links.folders.filter((folder) => folder.source.type === 'bookmarks')
    const local = data.links.folders.filter((folder) => folder.source.type !== 'bookmarks')
    const nextFolders = [...synced, ...local]

    if (!sameFolderList(data.links.folders, nextFolders)) {
        data.links.folders = nextFolders
        mutated = true
    }

    if (data.links.folders.length > 1 && !data.links.foldersOn) {
        data.links.foldersOn = true
        mutated = true
    }

    if (removeEmptyDefaultFolder(data)) {
        mutated = true
    }

    if (!data.links.folders.some((folder) => folder.id === data.links.selectedFolder)) {
        data.links.selectedFolder = data.links.folders[0]?.id ?? 'default'
        mutated = true
    }

    return mutated
}

function mirrorFolderIntoFolder(folder: LinkFolder, bookmarks: BookmarksFolderItem[]): boolean {
    const sourceBookmarks = uniqueBookmarksByUrl(bookmarks)
    const previous = JSON.stringify(folder.items)
    const existingByBookmarkId = new Map<string, LinkElem>()
    const existingByUrl = new Map<string, LinkElem>()

    for (const link of flattenLinks(folder.items)) {
        if (link.bookmarkId) {
            existingByBookmarkId.set(link.bookmarkId, link)
        } else {
            existingByUrl.set(normalizeBookmarkUrl(link.url), link)
        }
    }

    const nextItems: LinkElem[] = []

    for (const bookmark of sourceBookmarks) {
        const existing = existingByBookmarkId.get(bookmark.id) ?? existingByUrl.get(normalizeBookmarkUrl(bookmark.url))
        const link = existing ?? validateLink(bookmark.title, bookmark.url, bookmark.id)

        link.title = bookmark.title
        link.url = bookmark.url
        link.bookmarkId = bookmark.id
        nextItems.push(link)
    }

    folder.items = nextItems
    return previous !== JSON.stringify(folder.items)
}

function applyFavoritesFromToolbar(data: Sync): boolean {
    const folder = browserBookmarkFolders.find((item) => item.title === FAVORITES_FOLDER)

    if (!folder) {
        return false
    }

    const previous = JSON.stringify(data.links.favorites)
    const existingByBookmarkId = new Map<string, LinkElem>()
    const existingByUrl = new Map<string, LinkElem>()

    for (const link of data.links.favorites) {
        if (link.bookmarkId) {
            existingByBookmarkId.set(link.bookmarkId, link)
        } else {
            existingByUrl.set(normalizeBookmarkUrl(link.url), link)
        }
    }

    data.links.favorites = uniqueBookmarksByUrl(folder.bookmarks).map((bookmark) => {
        const existing = existingByBookmarkId.get(bookmark.id) ?? existingByUrl.get(normalizeBookmarkUrl(bookmark.url))
        const link = existing ?? validateLink(bookmark.title, bookmark.url, bookmark.id)

        link.title = bookmark.title
        link.url = bookmark.url
        link.bookmarkId = bookmark.id
        return link
    })

    return previous !== JSON.stringify(data.links.favorites)
}

function removeEmptyDefaultFolder(data: Sync): boolean {
    if (data.links.folders.length < 2) {
        return false
    }

    const defaultFolder = data.links.folders.find((folder) => folder.id === 'default')

    if (!defaultFolder || defaultFolder.items.length > 0) {
        return false
    }

    data.links.folders = data.links.folders.filter((folder) => folder.id !== 'default')

    if (data.links.selectedFolder === 'default') {
        data.links.selectedFolder = data.links.folders[0]?.id ?? 'default'
    }

    return true
}

function sameFolderList(first: LinkFolder[], second: LinkFolder[]): boolean {
    return first.length === second.length && first.every((folder, index) => folder.id === second[index]?.id)
}

function uniqueBookmarksByUrl(bookmarks: BookmarksFolderItem[]): BookmarksFolderItem[] {
    const seen = new Set<string>()
    const unique: BookmarksFolderItem[] = []

    for (const bookmark of bookmarks) {
        const url = normalizeBookmarkUrl(bookmark.url)

        if (!url || seen.has(url)) {
            continue
        }

        seen.add(url)
        unique.push(bookmark)
    }

    return unique
}

function addBookmarkListeners(): void {
    if (bookmarkListenerAdded) {
        return
    }

    bookmarkListenerAdded = true

    const listeners = ['onChanged', 'onCreated', 'onRemoved', 'onMoved'] as const

    for (const event of listeners) {
        EXTENSION?.bookmarks?.[event]?.addListener(() => {
            if (bookmarkRestoreInProgress) {
                bookmarkRefreshQueued = true
                return
            }

            refreshSyncedGroups()
        })
    }
}

export async function refreshSyncedGroups(): Promise<void> {
    const data = await storage.sync.get()
    const treenode = await getBookmarkTree()

    if (!treenode) {
        return
    }

    browserBookmarkFolders = bookmarkTreeToFolderList(treenode[0])
    let mutated = applySyncedFolders(data)
    mutated = applyFavoritesFromToolbar(data) || mutated

    if (!mutated) {
        return
    }

    await storage.sync.set(data)
    const local = await storage.local.get()
    initFolders(data)
    initblocks(data, local)
}

export async function syncBookmarksUpdate(update: BookmarkLinksUpdate, data: Sync): Promise<boolean> {
    if (!EXTENSION?.bookmarks) {
        return false
    }

    if (!shouldBlockLocalBookmarkUpdate(update, data)) {
        return false
    }

    const refreshed = await initBookmarkSync(data)
    await renderLinksFromSync(refreshed)
    return true
}

export async function bootstrapBookmarksFromConfig(data: Sync): Promise<Sync> {
    return await initBookmarkSync(data)
}

export async function restoreBookmarksFromConfig(data: Sync): Promise<boolean> {
    const folders = collectRestorableBookmarkFolders(data)

    if (!EXTENSION || folders.size === 0) {
        return false
    }

    holdBookmarkRefreshes()
    const root = await getRestorableRoot()

    if (!root || !EXTENSION.bookmarks) {
        releaseBookmarkRefreshesSoon()
        return false
    }

    const bookmarksApi = EXTENSION.bookmarks
    const toolbar = root.children?.[0] ?? root
    const folderIdsByTitle = bookmarkFolderIdsByTitle(root)
    const urlsByParentId = directBookmarkUrlsByParentId(root)
    let createdAny = false

    for (const [folderTitle, links] of orderedRestorableFolders(data, folders)) {
        const parentId = folderTitle === FAVORITES_FOLDER
            ? toolbar.id
            : await getOrCreateRestoreFolder(folderTitle, toolbar.id, bookmarksApi, folderIdsByTitle, urlsByParentId)

        if (!parentId) {
            continue
        }

        const existingUrls = urlsByParentId.get(parentId) ?? new Set<string>()
        urlsByParentId.set(parentId, existingUrls)

        for (const link of links) {
            const url = normalizeBookmarkUrl(link.url)

            if (!url || existingUrls.has(url)) {
                continue
            }

            try {
                await bookmarksApi.create({ parentId, title: link.title, url })
                existingUrls.add(url)
                createdAny = true
            } catch (_error) {
                // Keep restoring the rest if one stored URL is rejected by the browser.
            }
        }
    }

    releaseBookmarkRefreshesSoon()
    return createdAny
}

export async function replaceBookmarksFromConfig(current: Sync, next: Sync): Promise<boolean> {
    const desiredFolders = collectRestorableBookmarkFolders(next)
    const currentFolders = collectRestorableBookmarkFolders(current)

    if (!EXTENSION || !EXTENSION.bookmarks) {
        return false
    }

    holdBookmarkRefreshes()
    const root = await getRestorableRoot()

    if (!root) {
        releaseBookmarkRefreshesSoon()
        return false
    }

    const bookmarksApi = EXTENSION.bookmarks
    const toolbar = root.children?.[0] ?? root
    const folderIdsByTitle = bookmarkFolderIdsByTitle(root)
    const bookmarksByParentId = directBookmarksByParentId(root)
    const targetFolders = uniqueStrings([...currentFolders.keys(), ...desiredFolders.keys()])
    let mutated = false

    for (const folderTitle of orderedRestorableFolderNames(next, desiredFolders, targetFolders)) {
        const desiredLinks = desiredFolders.get(folderTitle) ?? []
        const parentId = folderTitle === FAVORITES_FOLDER
            ? toolbar.id
            : await getOrCreateRestoreFolder(folderTitle, toolbar.id, bookmarksApi, folderIdsByTitle, new Map())

        if (!parentId) {
            continue
        }

        const existingBookmarks = bookmarksByParentId.get(parentId) ?? []
        const desiredUrls = new Set(desiredLinks.map((link) => normalizeBookmarkUrl(link.url)).filter(Boolean))
        const existingByUrl = new Map<string, BookmarksFolderItem[]>()

        for (const bookmark of existingBookmarks) {
            const url = normalizeBookmarkUrl(bookmark.url)
            const list = existingByUrl.get(url) ?? []
            list.push(bookmark)
            existingByUrl.set(url, list)
        }

        for (const bookmark of existingBookmarks) {
            const url = normalizeBookmarkUrl(bookmark.url)

            if (!desiredUrls.has(url)) {
                try {
                    await bookmarksApi.remove(bookmark.id)
                    mutated = true
                } catch (_error) {
                    // Keep applying the rest of the explicit config.
                }
            }
        }

        for (let index = 0; index < desiredLinks.length; index++) {
            const link = desiredLinks[index]
            const url = normalizeBookmarkUrl(link.url)

            if (!url) {
                continue
            }

            const existing = existingByUrl.get(url)?.shift()

            if (existing) {
                try {
                    if (existing.title !== link.title || existing.url !== url) {
                        await bookmarksApi.update(existing.id, { title: link.title, url })
                        mutated = true
                    }
                    if (existing.index !== index) {
                        await bookmarksApi.move(existing.id, { parentId, index })
                        mutated = true
                    }
                } catch (_error) {
                    // Keep applying the rest of the explicit config.
                }
            } else {
                try {
                    await bookmarksApi.create({ parentId, index, title: link.title, url })
                    mutated = true
                } catch (_error) {
                    // Keep applying the rest of the explicit config.
                }
            }
        }

        for (const [url, bookmarks] of existingByUrl) {
            if (!desiredUrls.has(url)) {
                continue
            }

            for (const bookmark of bookmarks) {
                try {
                    await bookmarksApi.remove(bookmark.id)
                    mutated = true
                } catch (_error) {
                    // Keep applying the rest of the explicit config.
                }
            }
        }
    }

    releaseBookmarkRefreshesSoon()
    return mutated
}

function shouldBlockLocalBookmarkUpdate(update: BookmarkLinksUpdate, data: Sync): boolean {
    if (update.addLinks) {
        return update.addLinks.some((link) =>
            isSyncedBookmarkFolder(data, link.folder ?? link.group ?? data.links.selectedFolder)
        )
    }

    if (update.updateLink) {
        return isMirroredBookmarkLink(data, update.updateLink.id)
    }

    if (update.deleteLinks) {
        return update.deleteLinks.some((id) => isMirroredBookmarkLink(data, id))
    }

    if (update.moveLinks) {
        return update.moveLinks.some((id) => isMirroredBookmarkLink(data, id))
    }

    if (update.moveFavorites) {
        return true
    }

    if (update.moveToFolder) {
        const target = update.moveToFolder.target
        const ids = update.moveToFolder.ids ?? (update.moveToFolder.source ? [update.moveToFolder.source] : [])
        return isSyncedBookmarkFolder(data, target) || ids.some((id) => isMirroredBookmarkLink(data, id))
    }

    if (update.moveToSubfolder) {
        return isMirroredBookmarkLink(data, update.moveToSubfolder.source)
    }

    if (update.moveOutSubfolder) {
        return isSyncedBookmarkFolder(data, update.moveOutSubfolder.folder) ||
            update.moveOutSubfolder.ids.some((id) => isMirroredBookmarkLink(data, id))
    }

    if (update.folderTitle) {
        return isSyncedBookmarkFolder(data, update.folderTitle.old) ||
            isSyncedBookmarkFolder(data, update.folderTitle.new)
    }

    if (update.deleteFolder) {
        return isSyncedBookmarkFolder(data, update.deleteFolder)
    }

    if (update.moveFolders) {
        return update.moveFolders.some((folder) => isSyncedBookmarkFolder(data, folder))
    }

    if (update.unsyncFolder) {
        return isSyncedBookmarkFolder(data, update.unsyncFolder)
    }

    return false
}

function isSyncedBookmarkFolder(data: Sync, folder?: string): boolean {
    if (folder === FAVORITES_FOLDER) {
        return true
    }

    return !!folder && data.links.folders.some((item) => {
        return (item.id === folder || item.title === folder) && item.source.type === 'bookmarks'
    })
}

function isMirroredBookmarkLink(data: Sync, id: string): boolean {
    return allLinks(data).some((link) => link.id === id && !!link.bookmarkId)
}

function collectRestorableBookmarkFolders(data: Sync): Map<string, LinkElem[]> {
    const folders = new Map<string, LinkElem[]>()

    for (const folder of data.links.folders) {
        if (folder.source.type !== 'bookmarks') {
            continue
        }

        folders.set(folder.title, uniqueRestorableBookmarks(flattenLinks(folder.items)))
    }

    if (data.links.favorites.length > 0) {
        folders.set(FAVORITES_FOLDER, uniqueRestorableBookmarks(data.links.favorites))
    }

    return folders
}

function orderedRestorableFolders(data: Sync, folders: Map<string, LinkElem[]>): [string, LinkElem[]][] {
    return orderedRestorableFolderNames(data, folders).map((folder) => [folder, folders.get(folder) ?? []])
}

function orderedRestorableFolderNames(data: Sync, folders: Map<string, LinkElem[]>, extras: string[] = []): string[] {
    const configuredFolders = data.links.folders
        .map((folder) => folder.title)
        .filter((folder) => folders.has(folder) || extras.includes(folder))
    const extraFolders = uniqueStrings([...folders.keys(), ...extras]).filter((folder) => {
        return folder !== FAVORITES_FOLDER && !configuredFolders.includes(folder)
    })
    const favorites = folders.has(FAVORITES_FOLDER) || extras.includes(FAVORITES_FOLDER) ? [FAVORITES_FOLDER] : []

    return [...configuredFolders, ...extraFolders, ...favorites]
}

function uniqueRestorableBookmarks(links: LinkElem[]): LinkElem[] {
    const seenUrls = new Set<string>()
    const unique: LinkElem[] = []

    for (const link of links) {
        const url = normalizeBookmarkUrl(link.url)

        if (!url || seenUrls.has(url)) {
            continue
        }

        seenUrls.add(url)
        unique.push(link)
    }

    return unique
}

function flattenLinks(items: LinkNode[]): LinkElem[] {
    const links: LinkElem[] = []

    for (const item of items) {
        if (isElem(item)) {
            links.push(item)
            continue
        }

        if (isSubfolder(item)) {
            links.push(...item.items)
        }
    }

    return links
}

async function getRestorableRoot(): Promise<Treenode | undefined> {
    let treenode = await getBookmarkTree()

    if (!treenode) {
        try {
            await getPermissions('bookmarks')
            treenode = await getBookmarkTree()
        } catch (_error) {
            settingsNotifications({ 'accept-permissions': true })
        }
    }

    return treenode?.[0]
}

function holdBookmarkRefreshes(): void {
    bookmarkRestoreInProgress = true

    if (bookmarkRestoreReleaseTimer) {
        clearTimeout(bookmarkRestoreReleaseTimer)
        bookmarkRestoreReleaseTimer = 0
    }
}

function releaseBookmarkRefreshesSoon(): void {
    if (bookmarkRestoreReleaseTimer) {
        clearTimeout(bookmarkRestoreReleaseTimer)
    }

    bookmarkRestoreReleaseTimer = setTimeout(() => {
        bookmarkRestoreInProgress = false
        bookmarkRestoreReleaseTimer = 0

        if (!bookmarkRefreshQueued) {
            return
        }

        bookmarkRefreshQueued = false
        refreshSyncedGroups()
    }, 300)
}

async function getOrCreateRestoreFolder(
    title: string,
    toolbarId: string,
    bookmarksApi: NonNullable<typeof EXTENSION>['bookmarks'],
    folderIdsByTitle: Map<string, string>,
    urlsByParentId: Map<string, Set<string>>,
): Promise<string | undefined> {
    const existingId = folderIdsByTitle.get(title)

    if (existingId) {
        return existingId
    }

    try {
        const folder = await bookmarksApi.create({ parentId: toolbarId, title })
        folderIdsByTitle.set(title, folder.id)
        urlsByParentId.set(folder.id, new Set())
        return folder.id
    } catch (_error) {
        return
    }
}

function bookmarkFolderIdsByTitle(treenode: Treenode): Map<string, string> {
    const folders = new Map<string, string>()
    const titleCounts = new Map<string, number>()

    function uniqueFolderTitle(path: string[]): string {
        const base = path.join(' / ') || 'Default folder'
        const count = titleCounts.get(base) ?? 0
        titleCounts.set(base, count + 1)
        return count === 0 ? base : `${base} (${count + 1})`
    }

    function walk(node: Treenode, path: string[] = []): void {
        if (!node.children) {
            return
        }

        const isRootNode = !node.title
        const isToolbarNode = node.id === treenode.children?.[0]?.id
        const currentPath = isRootNode || isToolbarNode ? path : [...path, node.title || 'Default folder']

        if (!isRootNode && !isToolbarNode) {
            folders.set(uniqueFolderTitle(currentPath), node.id)
        }

        for (const child of node.children) {
            if (child.children) {
                walk(child, currentPath)
            }
        }
    }

    walk(treenode)
    return folders
}

function directBookmarkUrlsByParentId(treenode: Treenode): Map<string, Set<string>> {
    const urlsByParentId = new Map<string, Set<string>>()

    function walk(node: Treenode): void {
        if (!node.children) {
            return
        }

        const urls = urlsByParentId.get(node.id) ?? new Set<string>()

        for (const child of node.children) {
            if (child.url) {
                urls.add(normalizeBookmarkUrl(child.url))
            }
        }

        urlsByParentId.set(node.id, urls)

        for (const child of node.children) {
            if (child.children) {
                walk(child)
            }
        }
    }

    walk(treenode)
    return urlsByParentId
}

function directBookmarksByParentId(treenode: Treenode): Map<string, BookmarksFolderItem[]> {
    const bookmarksByParentId = new Map<string, BookmarksFolderItem[]>()

    function walk(node: Treenode): void {
        if (!node.children) {
            return
        }

        const bookmarks = bookmarksByParentId.get(node.id) ?? []

        for (const child of node.children) {
            if (child.url) {
                bookmarks.push({
                    id: child.id,
                    parentId: child.parentId,
                    index: child.index,
                    title: child.title ?? '',
                    url: child.url,
                    dateAdded: child.dateAdded ?? 0,
                })
            }
        }

        bookmarksByParentId.set(node.id, bookmarks)

        for (const child of node.children) {
            if (child.children) {
                walk(child)
            }
        }
    }

    walk(treenode)
    return bookmarksByParentId
}

function normalizeBookmarkUrl(url: string): string {
    return url.trim()
}

async function getBookmarkTree(): Promise<Treenode[] | undefined> {
    try {
        const live = await EXTENSION?.bookmarks?.getTree()
        if (live) {
            return live as Treenode[]
        }
    } catch (_error) {
        // fall through to startup cache
    }

    return globalThis.startupBookmarks
}

function bookmarkTreeToFolderList(treenode: Treenode): BookmarksFolder[] {
    const folders: Record<string, BookmarksFolder> = {}
    const titleCounts = new Map<string, number>()

    function uniqueFolderTitle(path: string[]): string {
        const base = path.join(' / ') || 'Default folder'
        const count = titleCounts.get(base) ?? 0
        titleCounts.set(base, count + 1)
        return count === 0 ? base : `${base} (${count + 1})`
    }

    function mapBookmark(node: Treenode): BookmarksFolderItem | undefined {
        if (!node.url) {
            return
        }

        return {
            id: node.id,
            parentId: node.parentId,
            index: node.index,
            title: node.title ?? '',
            url: node.url,
            dateAdded: node.dateAdded ?? 0,
        }
    }

    function uniqueBookmarks(bookmarks: BookmarksFolderItem[]): BookmarksFolderItem[] {
        const seen = new Set<string>()
        const unique: BookmarksFolderItem[] = []

        for (const bookmark of bookmarks) {
            if (seen.has(bookmark.id)) {
                continue
            }

            seen.add(bookmark.id)
            unique.push(bookmark)
        }

        return unique
    }

    function addToolbarDirectLinksToFavorites(root: Treenode): void {
        const toolbar = root.children?.[0]
        const directBookmarks: BookmarksFolderItem[] = []

        for (const child of toolbar?.children ?? []) {
            const mapped = mapBookmark(child)
            if (mapped) directBookmarks.push(mapped)
        }

        folders[FAVORITES_FOLDER] = {
            id: toolbar?.id ?? FAVORITES_FOLDER,
            title: FAVORITES_FOLDER,
            displayTitle: tradThis('Bookmarks bar'),
            bookmarks: uniqueBookmarks(directBookmarks),
        }
    }

    function createMapFromTree(node: Treenode, path: string[] = []): void {
        if (!node.children) {
            return
        }

        const isRootNode = !node.title
        const isToolbarNode = node.id === treenode.children?.[0]?.id
        const currentPath = isRootNode || isToolbarNode ? path : [...path, node.title || 'Default folder']
        const directBookmarks: BookmarksFolderItem[] = []

        for (const child of node.children) {
            const bookmark = mapBookmark(child)
            if (bookmark) directBookmarks.push(bookmark)
        }

        const uniqueDirectBookmarks = uniqueBookmarks(directBookmarks)

        if (!isRootNode && !isToolbarNode && uniqueDirectBookmarks.length > 0) {
            folders[node.id] = {
                id: node.id,
                title: uniqueFolderTitle(currentPath),
                bookmarks: uniqueDirectBookmarks,
            }
        }

        for (const child of node.children) {
            if (child.children) {
                createMapFromTree(child, currentPath)
            }
        }
    }

    addToolbarDirectLinksToFavorites(treenode)
    createMapFromTree(treenode)
    return Object.values(folders)
}

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))]
}

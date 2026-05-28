import { initblocks, validateLink } from './index.ts'
import { initFolders } from './groups.ts'
import { orderBookmarkToolbarChildren } from './bookmark-order.ts'
import { isElem, isSubfolder } from './helpers.ts'
import { FAVORITES_FOLDER, getFolderByTitle, removeFolder } from './model.ts'

import { EXTENSION } from '../../defaults.ts'
import { tradThis } from '../../utils/translations.ts'
import { stableStringify } from '../../utils/stringify.ts'
import { settingsNotifications } from '../../utils/notifications.ts'
import { getPermissions } from '../../utils/permissions.ts'
import { storage } from '../../storage.ts'

import type { LinkElem, LinkNode, LinkSubfolder } from '../../../types/shared.ts'
import type { LinkFolder, Sync } from '../../../types/sync.ts'

type Treenode = browser.bookmarks.BookmarkTreeNode

type BookmarksFolder = {
    id: string
    title: string
    displayTitle?: string
    bookmarks: BookmarksFolderItem[]
    children: BookmarksFolder[]
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
        id?: string
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
    unsyncFolder?: string
}

let browserBookmarkFolders: BookmarksFolder[] = []
let bookmarkListenerAdded = false
let bookmarkRestoreInProgress = false
let bookmarkRefreshQueued = false
let bookmarkRestoreReleaseTimer = 0

const skipBookmarkSync = !!sessionStorage.getItem('skipBookmarkSync')
sessionStorage.removeItem('skipBookmarkSync')

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

    if (!skipBookmarkSync) {
        let mutated = applySyncedFolders(data)
        mutated = applyFavoritesFromToolbar(data) || mutated

        if (mutated) {
            await storage.sync.set(data)
        }
    }

    addBookmarkListeners()
    return data
}

function applySyncedFolders(data: Sync): boolean {
    let mutated = false
    const syncedFolderIds: string[] = []

    for (const browserFolder of browserBookmarkFolders) {
        if (browserFolder.title === FAVORITES_FOLDER) {
            continue
        }

        if (
            browserFolder.title === 'default' && browserFolder.bookmarks.length === 0 &&
            browserFolder.children.length === 0
        ) {
            continue
        }

        let folder = data.links.folders.find((f) => f.id === browserFolder.id)

        if (!folder) {
            folder = getFolderByTitle(data, browserFolder.title)
        }

        if (!folder) {
            folder = {
                id: browserFolder.id,
                title: browserFolder.title,
                items: [],
            }
            data.links.folders.push(folder)
            mutated = true
        }

        if (folder.title !== browserFolder.title) {
            folder.title = browserFolder.title
            mutated = true
        }

        if (folder.id !== browserFolder.id) {
            if (data.links.selectedFolder === folder.id) {
                data.links.selectedFolder = browserFolder.id
            }
            folder.id = browserFolder.id
            mutated = true
        }

        syncedFolderIds.push(folder.id)
        mutated = mirrorFolderIntoFolder(folder, browserFolder) || mutated
    }

    for (const folder of [...data.links.folders]) {
        if (!syncedFolderIds.includes(folder.id)) {
            removeFolder(data, folder.id)
            mutated = true
        }
    }

    if (data.links.folders.length > 1 && !data.links.foldersOn) {
        data.links.foldersOn = true
        mutated = true
    }

    if (!data.links.folders.some((folder) => folder.id === data.links.selectedFolder)) {
        data.links.selectedFolder = data.links.folders[0]?.id ?? ''
        mutated = true
    }

    return mutated
}

function mirrorFolderIntoFolder(folder: LinkFolder, browserFolder: BookmarksFolder): boolean {
    const previous = stableStringify(folder.items)
    folder.items = buildItemsFromBrowserFolder(browserFolder)
    return previous !== stableStringify(folder.items)
}

function buildItemsFromBrowserFolder(browserFolder: BookmarksFolder): LinkNode[] {
    const items: LinkNode[] = []

    for (const bookmark of browserFolder.bookmarks) {
        items.push(validateLink(bookmark.title, bookmark.url, bookmark.id))
    }

    for (const child of browserFolder.children) {
        const subfolder: LinkSubfolder = {
            id: child.id,
            title: child.title,
            items: buildItemsFromBrowserFolder(child),
        }
        items.push(subfolder)
    }

    return items
}

function applyFavoritesFromToolbar(data: Sync): boolean {
    const folder = browserBookmarkFolders.find((item) => item.title === FAVORITES_FOLDER)

    if (!folder) {
        return false
    }

    const previous = stableStringify(data.links.favorites)
    const existingById = new Map<string, LinkElem>()
    const existingByUrl = new Map<string, LinkElem>()

    for (const link of data.links.favorites) {
        existingById.set(link.id, link)
        existingByUrl.set(normalizeBookmarkUrl(link.url), link)
    }

    data.links.favorites = folder.bookmarks.map((bookmark) => {
        const existing = existingById.get(bookmark.id) ?? existingByUrl.get(normalizeBookmarkUrl(bookmark.url))
        const link = existing ?? validateLink(bookmark.title, bookmark.url, bookmark.id)

        link.id = bookmark.id
        link.title = bookmark.title
        link.url = bookmark.url
        return link
    })

    return previous !== stableStringify(data.links.favorites)
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

export function syncBookmarksUpdate(_update: BookmarkLinksUpdate, _data: Sync): Promise<boolean> {
    return Promise.resolve(false)
}

export async function bootstrapBookmarksFromConfig(data: Sync): Promise<Sync> {
    const treenode = await getBookmarkTree()

    if (!treenode) {
        return data
    }

    if (skipBookmarkSync) {
        return data
    }

    browserBookmarkFolders = bookmarkTreeToFolderList(treenode[0])
    let mutated = applySyncedFolders(data)
    mutated = applyFavoritesFromToolbar(data) || mutated

    if (mutated) {
        await storage.sync.set(data)
    }

    return data
}

export async function restoreBookmarksFromConfig(data: Sync): Promise<boolean> {
    const folders = collectRestorableBookmarkItems(data)

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

    for (const [folderTitle, items] of orderedRestorableFolders(data, folders)) {
        const parentId = folderTitle === FAVORITES_FOLDER
            ? toolbar.id
            : await getOrCreateRestoreFolder(folderTitle, toolbar.id, bookmarksApi, folderIdsByTitle, urlsByParentId)

        if (!parentId) {
            continue
        }

        const result = await restoreItemsToChrome(parentId, items, urlsByParentId, bookmarksApi)
        createdAny = result || createdAny
    }

    const reordered = await normalizeBookmarkToolbarOrder(bookmarksApi)

    releaseBookmarkRefreshesSoon()
    return createdAny || reordered
}

// Writes the Gist-side state into the user's Chrome bookmarks with Gist as
// the single source of truth. Duplicates are NOT collapsed — `desiredUrls`
// below is only used for membership checks, never to shorten `desiredLinks`,
// and `existingByUrl` shifts one Chrome bookmark per occurrence in Gist so a
// Gist with [A, A, B] writes three Chrome bookmarks even when Chrome only
// had one A to start with. Existing IDs are preserved when a URL match is
// available — important to avoid every download rotating every bookmark ID
// (which would cascade into avoidable cross-device upload churn).
export async function replaceBookmarksFromConfig(current: Sync, next: Sync): Promise<boolean> {
    const desiredFolders = collectRestorableBookmarkItems(next)
    const currentFolders = collectRestorableBookmarkItems(current)

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
    const chromeTree = buildChromeTreeMap(root)
    const targetFolders = uniqueStrings([...currentFolders.keys(), ...desiredFolders.keys()])
    let mutated = false

    for (const folderTitle of orderedRestorableFolderNames(next, desiredFolders, targetFolders)) {
        const desiredItems = desiredFolders.get(folderTitle) ?? []
        const parentId = folderTitle === FAVORITES_FOLDER
            ? toolbar.id
            : await getOrCreateRestoreFolder(folderTitle, toolbar.id, bookmarksApi, folderIdsByTitle, new Map())

        if (!parentId) {
            continue
        }

        const parentNode = chromeTree.get(parentId)
        const existingChildren = folderTitle === FAVORITES_FOLDER
            ? (parentNode?.children ?? []).filter((c) => !!c.url)
            : parentNode?.children ?? []
        const result = await syncItemsToChrome(parentId, desiredItems, existingChildren, bookmarksApi)
        mutated = result || mutated
    }

    for (const child of toolbar.children ?? []) {
        if (child.children && !desiredFolders.has(child.title ?? '')) {
            try {
                await bookmarksApi.removeTree(child.id)
                mutated = true
            } catch (_) {
                // best effort
            }
        }
    }

    mutated = await normalizeBookmarkToolbarOrder(bookmarksApi) || mutated

    releaseBookmarkRefreshesSoon()
    return mutated
}

function collectRestorableBookmarkItems(data: Sync): Map<string, LinkNode[]> {
    const folders = new Map<string, LinkNode[]>()

    for (const folder of data.links.folders) {
        folders.set(folder.title, folder.items)
    }

    if (data.links.favorites.length > 0) {
        folders.set(FAVORITES_FOLDER, data.links.favorites)
    }

    return folders
}

function orderedRestorableFolders(data: Sync, folders: Map<string, LinkNode[]>): [string, LinkNode[]][] {
    return orderedRestorableFolderNames(data, folders).map((folder) => [folder, folders.get(folder) ?? []])
}

function orderedRestorableFolderNames(data: Sync, folders: Map<string, LinkNode[]>, extras: string[] = []): string[] {
    const configuredFolders = data.links.folders
        .map((folder) => folder.title)
        .filter((folder) => folders.has(folder) || extras.includes(folder))
    const extraFolders = uniqueStrings([...folders.keys(), ...extras]).filter((folder) => {
        return folder !== FAVORITES_FOLDER && !configuredFolders.includes(folder)
    })
    const favorites = folders.has(FAVORITES_FOLDER) || extras.includes(FAVORITES_FOLDER) ? [FAVORITES_FOLDER] : []

    return [...configuredFolders, ...extraFolders, ...favorites]
}

async function getRestorableRoot(): Promise<Treenode | undefined> {
    const treenode = await getBookmarkTree()
    return treenode?.[0]
}

export function holdBookmarkRefreshes(): void {
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

async function normalizeBookmarkToolbarOrder(
    bookmarksApi: NonNullable<typeof EXTENSION>['bookmarks'],
): Promise<boolean> {
    const root = await getRestorableRoot()
    const toolbar = root?.children?.[0] ?? root

    if (!toolbar?.children) {
        return false
    }

    const current = [...toolbar.children].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const ordered = orderBookmarkToolbarChildren(current)
    let mutated = false

    for (let index = 0; index < ordered.length; index++) {
        const child = ordered[index]
        const currentIndex = current.findIndex((item) => item.id === child.id)

        if (currentIndex < 0 || currentIndex === index) {
            continue
        }

        try {
            await bookmarksApi.move(child.id, { parentId: toolbar.id, index })
            current.splice(currentIndex, 1)
            current.splice(index, 0, child)
            mutated = true
        } catch (_error) {
            // Reordering is best-effort; the bookmark contents were already restored.
        }
    }

    return mutated
}

function buildChromeTreeMap(root: Treenode): Map<string, Treenode> {
    const map = new Map<string, Treenode>()

    function walk(node: Treenode): void {
        map.set(node.id, node)
        for (const child of node.children ?? []) {
            walk(child)
        }
    }

    walk(root)
    return map
}

async function syncItemsToChrome(
    parentId: string,
    desiredItems: LinkNode[],
    existingChildren: Treenode[],
    bookmarksApi: NonNullable<typeof EXTENSION>['bookmarks'],
): Promise<boolean> {
    let mutated = false

    const desiredLinks = desiredItems.filter(isElem)
    const desiredSubfolders = desiredItems.filter(isSubfolder)

    const existingBookmarks: BookmarksFolderItem[] = []
    const existingFolders: Treenode[] = []

    for (const child of existingChildren) {
        if (child.url) {
            existingBookmarks.push({
                id: child.id,
                parentId: child.parentId,
                index: child.index,
                title: child.title ?? '',
                url: child.url,
                dateAdded: child.dateAdded ?? 0,
            })
        } else if (child.children) {
            existingFolders.push(child)
        }
    }

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
                // Best effort
            }
        }
    }

    for (let index = 0; index < desiredLinks.length; index++) {
        const link = desiredLinks[index]
        const url = normalizeBookmarkUrl(link.url)
        if (!url) continue

        const existing = existingByUrl.get(url)?.shift()

        if (existing) {
            try {
                if (existing.title !== link.title || existing.url !== url) {
                    await bookmarksApi.update(existing.id, { title: link.title, url })
                    mutated = true
                }
            } catch (_error) {
                // Best effort
            }
        } else {
            try {
                await bookmarksApi.create({ parentId, title: link.title, url })
                mutated = true
            } catch (_error) {
                // Best effort
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
                // Best effort
            }
        }
    }

    const desiredSubfolderTitles = new Set(desiredSubfolders.map((sf) => sf.title))
    const existingFoldersByTitle = new Map<string, Treenode>()

    for (const folder of existingFolders) {
        existingFoldersByTitle.set(folder.title ?? '', folder)
    }

    for (const folder of existingFolders) {
        if (!desiredSubfolderTitles.has(folder.title ?? '')) {
            try {
                await bookmarksApi.removeTree(folder.id)
                mutated = true
            } catch (_error) {
                // Best effort
            }
        }
    }

    for (const subfolder of desiredSubfolders) {
        let chromeFolder = existingFoldersByTitle.get(subfolder.title)

        if (!chromeFolder) {
            try {
                const created = await bookmarksApi.create({ parentId, title: subfolder.title })
                chromeFolder = { ...created, children: [] }
                mutated = true
            } catch (_error) {
                continue
            }
        }

        const result = await syncItemsToChrome(
            chromeFolder.id,
            subfolder.items,
            chromeFolder.children ?? [],
            bookmarksApi,
        )
        mutated = result || mutated
    }

    return mutated
}

async function restoreItemsToChrome(
    parentId: string,
    items: LinkNode[],
    urlsByParentId: Map<string, Set<string>>,
    bookmarksApi: NonNullable<typeof EXTENSION>['bookmarks'],
): Promise<boolean> {
    let createdAny = false
    const existingUrls = urlsByParentId.get(parentId) ?? new Set<string>()
    urlsByParentId.set(parentId, existingUrls)

    for (const item of items) {
        if (isElem(item)) {
            const url = normalizeBookmarkUrl(item.url)
            if (!url || existingUrls.has(url)) continue

            try {
                await bookmarksApi.create({ parentId, title: item.title, url })
                existingUrls.add(url)
                createdAny = true
            } catch (_error) {
                // Best effort
            }
        } else if (isSubfolder(item)) {
            try {
                const created = await bookmarksApi.create({ parentId, title: item.title })
                const result = await restoreItemsToChrome(created.id, item.items, urlsByParentId, bookmarksApi)
                createdAny = result || createdAny
            } catch (_error) {
                // Best effort
            }
        }
    }

    return createdAny
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
    const toolbar = treenode.children?.[0]
    if (!toolbar?.children) return []

    const results: BookmarksFolder[] = []

    const directBookmarks: BookmarksFolderItem[] = []
    for (const child of toolbar.children) {
        if (child.url) {
            directBookmarks.push(mapTreeNode(child))
        }
    }

    results.push({
        id: toolbar.id ?? FAVORITES_FOLDER,
        title: FAVORITES_FOLDER,
        displayTitle: tradThis('Bookmarks bar'),
        bookmarks: directBookmarks,
        children: [],
    })

    for (const child of toolbar.children) {
        if (child.children) {
            results.push(treeNodeToFolder(child))
        }
    }

    return results
}

function treeNodeToFolder(node: Treenode): BookmarksFolder {
    const bookmarks: BookmarksFolderItem[] = []
    const children: BookmarksFolder[] = []

    for (const child of node.children ?? []) {
        if (child.url) {
            bookmarks.push(mapTreeNode(child))
        } else if (child.children) {
            children.push(treeNodeToFolder(child))
        }
    }

    return {
        id: node.id,
        title: node.title || 'Folder',
        bookmarks,
        children,
    }
}

function mapTreeNode(node: Treenode): BookmarksFolderItem {
    return {
        id: node.id,
        parentId: node.parentId,
        index: node.index,
        title: node.title ?? '',
        url: node.url ?? '',
        dateAdded: node.dateAdded ?? 0,
    }
}

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))]
}

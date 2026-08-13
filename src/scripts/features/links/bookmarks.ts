import { initblocks } from './index.ts'
import { initFolders } from './groups.ts'
import { isElem, isSubfolder } from './helpers.ts'
import { FAVORITES_FOLDER, syncWithBookmarks } from './model.ts'

import { EXTENSION } from '../../defaults.ts'
import { tradThis } from '../../utils/translations.ts'
import { stableStringify } from '../../utils/stringify.ts'
import { settingsNotifications } from '../../utils/notifications.ts'
import { getPermissions } from '../../utils/permissions.ts'
import { storage } from '../../storage.ts'

import type { LinkElem, LinkNode } from '../../../types/shared.ts'
import type { BookmarkLinksState, LinkFolder, Sync, SyncSnapshot } from '../../../types/sync.ts'

type Treenode = chrome.bookmarks.BookmarkTreeNode
type BookmarksApi = NonNullable<NonNullable<typeof EXTENSION>['bookmarks']>

type BookmarksFolder = {
    kind: 'favorites' | 'folder'
    id: string
    title: string
    displayTitle?: string
    items: LinkNode[]
}

type BrowserBookmarkSnapshot = {
    folders: BookmarksFolder[]
    toolbarOrder: string[]
}

type ComparableNode = {
    kind: 'bookmark' | 'folder'
    title: string
    url?: string
    items?: ComparableNode[]
}

export class BookmarkAccessError extends Error {
    override name = 'BookmarkAccessError'
}

export class BookmarkRestoreError extends Error {
    override name = 'BookmarkRestoreError'
}

let browserBookmarkFolders: BookmarksFolder[] = []
let browserBookmarkToolbarOrder: string[] = []
let bookmarkListenerAdded = false
let bookmarkRestoreInProgress = false
let bookmarkRefreshQueued = false
let bookmarkRestoreReleaseTimer = 0
let bookmarkDirtyTimer = 0
let bookmarkRefreshTimer = 0
let bookmarkRefreshRequested = false
let bookmarkRefreshPromise: Promise<void> | undefined
let bookmarksApiForTests: BookmarksApi | null | undefined

export async function linksImport(): Promise<void> {
    const data = await storage.sync.get()
    const refreshed = await buildBookmarkSnapshotFromConfig(data)
    await renderLinksFromSync(refreshed)
}

export function renderLinksFromSync(data: SyncSnapshot): void {
    if (!document.getElementById('linkblocks')) {
        return
    }

    initFolders(data)
    initblocks(data)
}

// Startup rendering may use the preloaded tree if the live API is temporarily
// unavailable. This cache is deliberately confined to startup rendering: an
// upload or destructive restore must always prove that a fresh live read worked.
export async function initBookmarkSync(data: Sync): Promise<SyncSnapshot> {
    const snapshot = syncWithBookmarks(data)
    let treenode: Treenode[] | undefined
    let liveTree = true

    try {
        treenode = await getLiveBookmarkTree()
    } catch (_error) {
        try {
            await getPermissions('bookmarks')
            treenode = await getLiveBookmarkTree()
        } catch (_permissionError) {
            settingsNotifications({ 'accept-permissions': true })
            treenode = globalThis.startupBookmarks
            liveTree = false
        }
    }

    if (!treenode) {
        browserBookmarkFolders = []
        return snapshot
    }

    try {
        applyLiveBrowserSnapshot(bookmarkTreeToFolderList(treenode))
    } catch (_error) {
        browserBookmarkFolders = []
        return snapshot
    }

    applyBrowserFolders(snapshot)
    if (liveTree) addBookmarkListeners()
    return snapshot
}

function applyBrowserFolders(data: SyncSnapshot): boolean {
    const links = data.links
    const previous = stableStringify({
        folders: links.folders,
        favorites: links.favorites,
        toolbarOrder: links.toolbarOrder,
    })
    const previousSelected = links.folders.find((folder) => folder.id === links.selectedFolder)
    const folders = browserBookmarkFolders.filter((folder) => folder.kind === 'folder')
    const favorites = browserBookmarkFolders.find((folder) => folder.kind === 'favorites')

    links.folders = folders.map((folder): LinkFolder => ({
        id: folder.id,
        title: folder.title,
        items: structuredClone(folder.items),
    }))
    links.favorites = (favorites?.items ?? []).filter(isElem).map((link) => ({ ...link }))
    links.toolbarOrder = [...browserBookmarkToolbarOrder]

    if (!links.folders.some((folder) => folder.id === links.selectedFolder)) {
        const sameTitle = previousSelected
            ? links.folders.find((folder) => folder.title === previousSelected.title)
            : undefined
        links.selectedFolder = sameTitle?.id ?? links.folders[0]?.id ?? ''
    }

    return previous !== stableStringify({
        folders: links.folders,
        favorites: links.favorites,
        toolbarOrder: links.toolbarOrder,
    })
}

function addBookmarkListeners(): void {
    if (bookmarkListenerAdded) {
        return
    }

    const bookmarksApi = getBookmarksApi()
    if (!bookmarksApi) return
    bookmarkListenerAdded = true

    const listeners = ['onChanged', 'onCreated', 'onRemoved', 'onMoved', 'onChildrenReordered'] as const

    for (const event of listeners) {
        bookmarksApi[event]?.addListener(() => {
            if (bookmarkRestoreInProgress) {
                bookmarkRefreshQueued = true
                return
            }

            markBookmarksDirty()
            queueBookmarkRefresh()
        })
    }
}

function markBookmarksDirty(): void {
    if (bookmarkDirtyTimer) {
        clearTimeout(bookmarkDirtyTimer)
    }

    bookmarkDirtyTimer = setTimeout(() => {
        bookmarkDirtyTimer = 0
        globalThis.dispatchEvent(new Event('bonjourr-sync-write'))
    })
}

function queueBookmarkRefresh(): void {
    bookmarkRefreshRequested = true

    if (bookmarkRefreshTimer) {
        clearTimeout(bookmarkRefreshTimer)
    }

    bookmarkRefreshTimer = setTimeout(() => {
        bookmarkRefreshTimer = 0
        void drainBookmarkRefreshes().catch((err) => {
            console.warn('Cannot refresh live bookmarks', err)
        })
    }, 50)
}

export function refreshSyncedGroups(): Promise<void> {
    bookmarkRefreshRequested = true
    if (bookmarkRefreshTimer) {
        clearTimeout(bookmarkRefreshTimer)
        bookmarkRefreshTimer = 0
    }
    return drainBookmarkRefreshes()
}

function drainBookmarkRefreshes(): Promise<void> {
    if (bookmarkRefreshPromise) {
        return bookmarkRefreshPromise
    }

    const active: Promise<void> = (async () => {
        while (bookmarkRefreshRequested && !bookmarkRestoreInProgress) {
            bookmarkRefreshRequested = false
            await refreshSyncedGroupsOnce()
        }
    })().finally(() => {
        if (bookmarkRefreshPromise === active) bookmarkRefreshPromise = undefined
    })
    bookmarkRefreshPromise = active
    return active
}

async function refreshSyncedGroupsOnce(): Promise<void> {
    const data = await storage.sync.get()
    const treenode = await getLiveBookmarkTree()
    applyLiveBrowserSnapshot(bookmarkTreeToFolderList(treenode))
    const snapshot = syncWithBookmarks(data)
    applyBrowserFolders(snapshot)
    initFolders(snapshot)
    initblocks(snapshot)
}

// This is the only snapshot suitable for upload. It intentionally has no
// startup-cache or empty-data fallback: inability to read live bookmarks must
// pause synchronization instead of turning "unknown" into "empty".
export async function buildBookmarkSnapshotFromConfig(data: Sync): Promise<SyncSnapshot> {
    const snapshot = syncWithBookmarks(structuredClone(data))
    const treenode = await getLiveBookmarkTree()
    applyLiveBrowserSnapshot(bookmarkTreeToFolderList(treenode))
    applyBrowserFolders(snapshot)
    return snapshot
}

// Writes Remote into the Chrome/Edge bookmarks bar. Every error propagates,
// and success is only returned after a fresh read-back exactly matches the
// requested tree. The caller can therefore advance its sync baseline safely.
export async function replaceBookmarksFromConfig(_current: Sync, next: Sync): Promise<boolean> {
    const bookmarksApi = requireBookmarksApi()
    const desiredToolbarItems = desiredToolbarNodes(next)

    holdBookmarkRefreshes()
    try {
        const liveTree = await getLiveBookmarkTree()
        const toolbar = findBookmarksToolbar(liveTree)
        const mutated = await syncItemsToChrome(
            toolbar.id,
            desiredToolbarItems,
            orderedTreeChildren(toolbar),
            bookmarksApi,
        )

        const verifiedTree = await getLiveBookmarkTree()
        const verifiedToolbar = findBookmarksToolbar(verifiedTree)
        const actual = comparableTreeNodes(orderedTreeChildren(verifiedToolbar))
        const expected = comparableLinkNodes(desiredToolbarItems)

        if (stableStringify(actual) !== stableStringify(expected)) {
            throw new BookmarkRestoreError('Chrome bookmarks did not match the requested snapshot after restore')
        }

        return mutated
    } finally {
        releaseBookmarkRefreshesSoon()
    }
}

function desiredToolbarNodes(data: Sync): LinkNode[] {
    const rawLinks = data.links as LinksStateWithOptionalBookmarks
    if (!Array.isArray(rawLinks.folders) || !Array.isArray(rawLinks.favorites)) {
        throw new BookmarkRestoreError('Bookmark snapshot is missing folders or favorites')
    }
    const folders = rawLinks.folders
    const favorites = rawLinks.favorites

    const ids = new Set<string>()
    const result: LinkNode[] = []

    for (const folder of folders) {
        assertFolder(folder, ids)
        result.push({ id: folder.id, title: folder.title, items: structuredClone(folder.items) })
    }
    for (const favorite of favorites) {
        assertNode(favorite, ids)
        if (!isElem(favorite)) {
            throw new BookmarkRestoreError('Favorites may only contain bookmarks')
        }
        result.push({ ...favorite })
    }

    if (rawLinks.toolbarOrder === undefined) return result
    if (!Array.isArray(rawLinks.toolbarOrder) || rawLinks.toolbarOrder.length !== result.length) {
        throw new BookmarkRestoreError('Bookmark toolbar order is invalid')
    }

    const byId = new Map(result.map((node) => [node.id, node]))
    const ordered: LinkNode[] = []
    for (const id of rawLinks.toolbarOrder) {
        if (typeof id !== 'string') throw new BookmarkRestoreError('Bookmark toolbar order is invalid')
        const node = byId.get(id)
        if (!node) throw new BookmarkRestoreError('Bookmark toolbar order references an unknown bookmark')
        ordered.push(node)
        byId.delete(id)
    }
    if (byId.size > 0) throw new BookmarkRestoreError('Bookmark toolbar order is incomplete')
    return ordered
}

type LinksStateWithOptionalBookmarks = Sync['links'] & Partial<BookmarkLinksState>

function assertFolder(folder: unknown, ids: Set<string>): asserts folder is LinkFolder {
    const value = folder as LinkFolder | undefined
    if (
        !value || typeof value.id !== 'string' || !value.id || typeof value.title !== 'string' ||
        !Array.isArray(value.items)
    ) {
        throw new BookmarkRestoreError('Invalid bookmark folder in snapshot')
    }
    assertUniqueId(value.id, ids)
    for (const item of value.items) assertNode(item, ids)
}

function assertNode(node: unknown, ids: Set<string>): asserts node is LinkNode {
    if (isElem(node)) {
        if (!node.id || typeof node.url !== 'string' || !node.url) {
            throw new BookmarkRestoreError('Invalid bookmark in snapshot')
        }
        assertUniqueId(node.id, ids)
        return
    }

    if (isSubfolder(node)) {
        if (!node.id) throw new BookmarkRestoreError('Invalid bookmark folder in snapshot')
        assertUniqueId(node.id, ids)
        for (const child of node.items) assertNode(child, ids)
        return
    }

    throw new BookmarkRestoreError('Invalid bookmark node in snapshot')
}

function assertUniqueId(id: string, ids: Set<string>): void {
    if (ids.has(id)) throw new BookmarkRestoreError(`Duplicate bookmark id: ${id}`)
    ids.add(id)
}

export function holdBookmarkRefreshes(): void {
    bookmarkRestoreInProgress = true

    if (bookmarkRestoreReleaseTimer) {
        clearTimeout(bookmarkRestoreReleaseTimer)
        bookmarkRestoreReleaseTimer = 0
    }
}

function releaseBookmarkRefreshesSoon(): void {
    if (bookmarkRestoreReleaseTimer) clearTimeout(bookmarkRestoreReleaseTimer)

    bookmarkRestoreReleaseTimer = setTimeout(() => {
        bookmarkRestoreInProgress = false
        bookmarkRestoreReleaseTimer = 0

        if (bookmarkRefreshQueued) {
            bookmarkRefreshQueued = false
            queueBookmarkRefresh()
        }
    }, 300)
}

async function syncItemsToChrome(
    parentId: string,
    desiredItems: LinkNode[],
    existingChildren: Treenode[],
    bookmarksApi: BookmarksApi,
): Promise<boolean> {
    const working = [...existingChildren]
    let mutated = false

    for (let targetIndex = 0; targetIndex < desiredItems.length; targetIndex++) {
        const desired = desiredItems[targetIndex]
        const matchIndex = findMatchingTreeNode(working, desired, targetIndex)
        let chromeNode: Treenode

        if (matchIndex < 0) {
            chromeNode = await createTreeNode(bookmarksApi, parentId, targetIndex, desired)
            working.splice(targetIndex, 0, chromeNode)
            mutated = true
        } else {
            chromeNode = working[matchIndex]
            if (matchIndex !== targetIndex || chromeNode.parentId !== parentId) {
                const moved = await bookmarksApi.move(chromeNode.id, { parentId, index: targetIndex })
                chromeNode = { ...chromeNode, ...moved, children: chromeNode.children }
                working.splice(matchIndex, 1)
                working.splice(targetIndex, 0, chromeNode)
                mutated = true
            }
        }

        if (isElem(desired)) {
            if (chromeNode.title !== desired.title || chromeNode.url !== desired.url) {
                const updated = await bookmarksApi.update(chromeNode.id, { title: desired.title, url: desired.url })
                working[targetIndex] = { ...chromeNode, ...updated }
                mutated = true
            }
            continue
        }

        if (chromeNode.title !== desired.title) {
            const updated = await bookmarksApi.update(chromeNode.id, { title: desired.title })
            chromeNode = { ...chromeNode, ...updated, children: chromeNode.children }
            working[targetIndex] = chromeNode
            mutated = true
        }

        mutated = await syncItemsToChrome(
            chromeNode.id,
            desired.items,
            orderedTreeChildren(chromeNode),
            bookmarksApi,
        ) || mutated
    }

    for (const obsolete of working.slice(desiredItems.length)) {
        if (isTreeFolder(obsolete)) {
            await bookmarksApi.removeTree(obsolete.id)
        } else {
            await bookmarksApi.remove(obsolete.id)
        }
        mutated = true
    }

    return mutated
}

function findMatchingTreeNode(existing: Treenode[], desired: LinkNode, fromIndex: number): number {
    const candidates = existing.slice(fromIndex)

    if (isElem(desired)) {
        const byUrl = candidates.findIndex((node) => isTreeBookmark(node) && node.url === desired.url)
        if (byUrl >= 0) return fromIndex + byUrl
        const byId = candidates.findIndex((node) => isTreeBookmark(node) && node.id === desired.id)
        return byId < 0 ? -1 : fromIndex + byId
    }

    const byTitle = candidates.findIndex((node) => isTreeFolder(node) && node.title === desired.title)
    if (byTitle >= 0) return fromIndex + byTitle
    const byId = candidates.findIndex((node) => isTreeFolder(node) && node.id === desired.id)
    return byId < 0 ? -1 : fromIndex + byId
}

async function createTreeNode(
    bookmarksApi: BookmarksApi,
    parentId: string,
    index: number,
    desired: LinkNode,
): Promise<Treenode> {
    if (isElem(desired)) {
        return await bookmarksApi.create({ parentId, index, title: desired.title, url: desired.url }) as Treenode
    }

    const created = await bookmarksApi.create({ parentId, index, title: desired.title }) as Treenode
    return { ...created, children: [] }
}

function comparableLinkNodes(nodes: LinkNode[]): ComparableNode[] {
    return nodes.map((node): ComparableNode =>
        isElem(node)
            ? { kind: 'bookmark', title: node.title, url: node.url }
            : { kind: 'folder', title: node.title, items: comparableLinkNodes(node.items) }
    )
}

function comparableTreeNodes(nodes: Treenode[]): ComparableNode[] {
    return nodes.map((node): ComparableNode =>
        isTreeBookmark(node)
            ? { kind: 'bookmark', title: node.title ?? '', url: node.url ?? '' }
            : { kind: 'folder', title: node.title ?? '', items: comparableTreeNodes(orderedTreeChildren(node)) }
    )
}

function getBookmarksApi(): BookmarksApi | undefined {
    if (bookmarksApiForTests !== undefined) return bookmarksApiForTests ?? undefined
    return EXTENSION?.bookmarks ?? globalThis.chrome?.bookmarks as BookmarksApi | undefined
}

function requireBookmarksApi(): BookmarksApi {
    const bookmarksApi = getBookmarksApi()
    if (!bookmarksApi) throw new BookmarkAccessError('Chrome bookmarks API is unavailable')
    return bookmarksApi
}

async function getLiveBookmarkTree(): Promise<Treenode[]> {
    const bookmarksApi = requireBookmarksApi()

    try {
        const tree = await bookmarksApi.getTree()
        if (!Array.isArray(tree) || tree.length === 0) {
            throw new BookmarkAccessError('Chrome returned an empty bookmarks tree')
        }
        return tree as Treenode[]
    } catch (error) {
        if (error instanceof BookmarkAccessError) throw error
        throw new BookmarkAccessError(`Unable to read live Chrome bookmarks: ${String(error)}`)
    }
}

export function findBookmarksToolbar(treenodes: Treenode[]): Treenode {
    const allNodes = flattenTreeNodes(treenodes)
    const typed = allNodes.filter((node) => node.folderType === 'bookmarks-bar')

    if (typed.length === 1) return typed[0]
    if (typed.length > 1) throw new BookmarkAccessError('Chrome returned multiple bookmarks-bar roots')

    const legacy = allNodes.filter((node) => node.id === '1' && isTreeFolder(node))
    if (legacy.length === 1) return legacy[0]
    if (legacy.length > 1) throw new BookmarkAccessError('Chrome returned multiple legacy bookmarks-bar roots')

    throw new BookmarkAccessError('Unable to identify a unique Chrome bookmarks bar')
}

function flattenTreeNodes(nodes: Treenode[]): Treenode[] {
    const result: Treenode[] = []

    function walk(node: Treenode): void {
        result.push(node)
        for (const child of node.children ?? []) walk(child)
    }

    for (const node of nodes) walk(node)
    return result
}

function bookmarkTreeToFolderList(treenodes: Treenode[]): BrowserBookmarkSnapshot {
    const toolbar = findBookmarksToolbar(treenodes)
    const results: BookmarksFolder[] = [{
        kind: 'favorites',
        id: FAVORITES_FOLDER,
        title: FAVORITES_FOLDER,
        displayTitle: tradThis('Bookmarks bar'),
        items: orderedTreeChildren(toolbar).filter(isTreeBookmark).map(treeBookmarkToLink),
    }]

    for (const child of orderedTreeChildren(toolbar)) {
        if (isTreeFolder(child)) results.push(treeFolderToFolder(child))
    }

    return {
        folders: results,
        toolbarOrder: orderedTreeChildren(toolbar).map((node) => node.id),
    }
}

function applyLiveBrowserSnapshot(snapshot: BrowserBookmarkSnapshot): void {
    browserBookmarkFolders = snapshot.folders
    browserBookmarkToolbarOrder = snapshot.toolbarOrder
}

function treeFolderToFolder(node: Treenode): BookmarksFolder {
    return {
        kind: 'folder',
        id: node.id,
        title: node.title ?? '',
        items: orderedTreeChildren(node).map(treeNodeToLink),
    }
}

function treeNodeToLink(node: Treenode): LinkNode {
    if (isTreeBookmark(node)) return treeBookmarkToLink(node)
    return {
        id: node.id,
        title: node.title ?? '',
        items: orderedTreeChildren(node).map(treeNodeToLink),
    }
}

function treeBookmarkToLink(node: Treenode): LinkElem {
    return {
        id: node.id,
        title: node.title ?? '',
        url: node.url ?? '',
    }
}

function orderedTreeChildren(node: Treenode): Treenode[] {
    return [...(node.children ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
}

function isTreeBookmark(node: Treenode): boolean {
    return typeof node.url === 'string'
}

function isTreeFolder(node: Treenode): boolean {
    return Array.isArray(node.children)
}

export const __testing = {
    reset(): void {
        bookmarksApiForTests = undefined
        browserBookmarkFolders = []
        browserBookmarkToolbarOrder = []
        bookmarkListenerAdded = false
        bookmarkRestoreInProgress = false
        bookmarkRefreshQueued = false
        bookmarkRefreshRequested = false
        bookmarkRefreshPromise = undefined
        if (bookmarkRestoreReleaseTimer) clearTimeout(bookmarkRestoreReleaseTimer)
        if (bookmarkDirtyTimer) clearTimeout(bookmarkDirtyTimer)
        if (bookmarkRefreshTimer) clearTimeout(bookmarkRefreshTimer)
        bookmarkRestoreReleaseTimer = 0
        bookmarkDirtyTimer = 0
        bookmarkRefreshTimer = 0
    },
    setBookmarksApi(bookmarksApi: BookmarksApi | null): void {
        bookmarksApiForTests = bookmarksApi
    },
}

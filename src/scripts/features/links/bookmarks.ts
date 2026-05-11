import { FAVORITES_GROUP, initblocks, validateLink } from './index.ts'
import { initGroups } from './groups.ts'
import { isElem, isLink } from './helpers.ts'

import { EXTENSION } from '../../defaults.ts'
import { tradThis } from '../../utils/translations.ts'
import { settingsNotifications } from '../../utils/notifications.ts'
import { getPermissions } from '../../utils/permissions.ts'
import { storage } from '../../storage.ts'

import type { LinkElem } from '../../../types/shared.ts'
import type { Sync } from '../../../types/sync.ts'

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
        group?: string
        bookmark?: LinkElem['bookmark']
    }[]
    updateLink?: {
        id: string
        url?: string
        title: string
    }
    moveLinks?: string[]
    moveFavorites?: string[]
    moveToGroup?: {
        source?: string
        target: string
        ids: string[]
    }
    moveToFolder?: {
        source: string
        target: string
    }
    moveOutFolder?: { ids: string[]; group: string }
    deleteLinks?: string[]
    deleteGroup?: string
    groupTitle?: { old: string; new: string }
    moveGroups?: string[]
    unsyncGroup?: string
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
    initGroups(data)
    initblocks(data, local)
}

/**
 * Loads the browser bookmark tree, then mirrors any synced state into `data`.
 * Returns the (possibly mutated) `data` so callers can keep their in-memory
 * reference consistent with what was just persisted to storage.
 *
 * Safety guarantees:
 * - If the bookmark tree cannot be loaded, the caller's data is left untouched.
 * - If a synced group's source folder is missing, that group's local links are
 *   kept as-is. We never clear local data on a transient read failure.
 * - __favorites is never treated as a generic synced group. It is implicitly
 *   mirrored from the toolbar's direct links and reset whenever the toolbar
 *   has none, but it is not user-tracked in linkgroups.synced.
 */
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
    ensureBookmarkFolderRefs(data)

    // Mirror every browser bookmark folder. Chrome Bookmarks is the source of
    // truth; Bonjourr only keeps a local rendering snapshot.
    let mutated = applySyncedGroups(data)

    // Always mirror toolbar direct links into the implicit __favorites bucket.
    //    The favorites bar is a derived view of the toolbar, not a user group.
    mutated = applyFavoritesFromToolbar(data) || mutated

    if (mutated) {
        await storage.sync.set(data)
    }

    addBookmarkListeners()

    return data
}

/**
 * Mirror each synced group's links from the current browser bookmark tree.
 * Returns true when `data` was mutated.
 *
 * A missing source folder is treated as a no-op for that group, never as
 * "clear it". This avoids data loss when the bookmark tree is briefly
 * unavailable or the user has temporarily renamed/moved the source folder.
 */
function applySyncedGroups(data: Sync): boolean {
    let mutated = false
    const syncedGroups: string[] = []
    const previousSynced = data.linkgroups.synced.filter((group) => group !== FAVORITES_GROUP)

    data.linkgroups.bookmarkFolders ??= {}
    const previousGroupByFolderId = new Map(
        Object.entries(data.linkgroups.bookmarkFolders).map(([group, folderId]) => [folderId, group]),
    )

    for (const folder of browserBookmarkFolders) {
        const oldGroup = previousGroupByFolderId.get(folder.id)
        const group = folder.title

        if (group === FAVORITES_GROUP) {
            continue
        }

        if (oldGroup && oldGroup !== group && oldGroup !== FAVORITES_GROUP) {
            mutated = renameMirroredGroup(data, oldGroup, group) || mutated
        }

        syncedGroups.push(group)

        if (!data.linkgroups.groups.includes(group)) {
            data.linkgroups.groups.push(group)
            mutated = true
        }

        if (data.linkgroups.bookmarkFolders[group] !== folder.id) {
            data.linkgroups.bookmarkFolders[group] = folder.id
            mutated = true
        }

        if (mirrorFolderIntoGroup(data, group, folder.bookmarks)) {
            mutated = true
        }
    }

    for (const group of previousSynced) {
        if (!syncedGroups.includes(group)) {
            mutated = removeMirroredGroup(data, group) || mutated
        }
    }

    const localGroups = data.linkgroups.groups.filter((group) => {
        return group !== FAVORITES_GROUP && !syncedGroups.includes(group)
    })
    const nextGroups = uniqueStrings([...syncedGroups, ...localGroups])

    if (!sameStringList(data.linkgroups.groups, nextGroups)) {
        data.linkgroups.groups = nextGroups
        mutated = true
    }

    if (!sameStringList(data.linkgroups.synced, syncedGroups)) {
        data.linkgroups.synced = syncedGroups
        mutated = true
    }

    if (data.linkgroups.groups.length > 1 && !data.linkgroups.on) {
        data.linkgroups.on = true
        mutated = true
    }

    if (removeEmptyDefaultGroup(data)) {
        mutated = true
    }

    if (!data.linkgroups.groups.includes(data.linkgroups.selected)) {
        data.linkgroups.selected = data.linkgroups.groups[0] ?? 'default'
        mutated = true
    }

    return mutated
}

function renameMirroredGroup(data: Sync, oldGroup: string, newGroup: string): boolean {
    if (oldGroup === newGroup) {
        return false
    }

    for (const value of Object.values(data)) {
        if (isLink(value) && value.parent === oldGroup) {
            value.parent = newGroup
        }
    }

    data.linkgroups.groups = data.linkgroups.groups.map((group) => group === oldGroup ? newGroup : group)
    data.linkgroups.pinned = data.linkgroups.pinned.map((group) => group === oldGroup ? newGroup : group)
    data.linkgroups.synced = data.linkgroups.synced.map((group) => group === oldGroup ? newGroup : group)

    if (data.linkgroups.selected === oldGroup) {
        data.linkgroups.selected = newGroup
    }

    if (data.linkgroups.hidden[oldGroup]) {
        data.linkgroups.hidden[newGroup] = data.linkgroups.hidden[oldGroup]
        delete data.linkgroups.hidden[oldGroup]
    }

    if (data.linkgroups.bookmarkFolders[oldGroup]) {
        data.linkgroups.bookmarkFolders[newGroup] = data.linkgroups.bookmarkFolders[oldGroup]
        delete data.linkgroups.bookmarkFolders[oldGroup]
    }

    return true
}

function removeMirroredGroup(data: Sync, group: string): boolean {
    let mutated = false

    for (const [key, value] of Object.entries(data)) {
        if (isLink(value) && value.parent === group) {
            delete data[key]
            mutated = true
        }
    }

    const groups = data.linkgroups.groups.filter((value) => value !== group)
    const pinned = data.linkgroups.pinned.filter((value) => value !== group)
    const synced = data.linkgroups.synced.filter((value) => value !== group)

    if (!sameStringList(data.linkgroups.groups, groups)) {
        data.linkgroups.groups = groups
        mutated = true
    }
    if (!sameStringList(data.linkgroups.pinned, pinned)) {
        data.linkgroups.pinned = pinned
        mutated = true
    }
    if (!sameStringList(data.linkgroups.synced, synced)) {
        data.linkgroups.synced = synced
        mutated = true
    }

    if (data.linkgroups.hidden[group]) {
        delete data.linkgroups.hidden[group]
        mutated = true
    }
    if (data.linkgroups.bookmarkFolders[group]) {
        delete data.linkgroups.bookmarkFolders[group]
        mutated = true
    }

    if (data.linkgroups.selected === group) {
        data.linkgroups.selected = data.linkgroups.groups[0] ?? 'default'
        mutated = true
    }

    return mutated
}

function removeEmptyDefaultGroup(data: Sync): boolean {
    if (data.linkgroups.groups.length < 2) {
        return false
    }

    const defaultHasLinks = Object.values(data).some((value) => isLink(value) && value.parent === 'default')

    if (defaultHasLinks) {
        return false
    }

    data.linkgroups.groups = data.linkgroups.groups.filter((group) => group !== 'default')
    data.linkgroups.pinned = data.linkgroups.pinned.filter((group) => group !== 'default')
    data.linkgroups.synced = data.linkgroups.synced.filter((group) => group !== 'default')

    if (data.linkgroups.selected === 'default') {
        data.linkgroups.selected = data.linkgroups.groups[0] ?? 'default'
    }

    return true
}

function sameStringList(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
        return false
    }

    return a.every((value, index) => value === b[index])
}

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))]
}

/**
 * Strictly mirror the toolbar's direct links into the implicit __favorites
 * group. Always runs (independent of linkgroups.synced) so the favorites bar
 * is a 1:1 view of the toolbar at all times: add a toolbar link → it appears,
 * remove it → it disappears.
 *
 * Pre-requisite: addToolbarDirectLinksToFavorites always registers a
 * FAVORITES_GROUP bucket (possibly empty) when the bookmark tree was loaded.
 * If the bucket is missing it means we never managed to read the tree, so we
 * skip — never silently drop local data on a transient API failure.
 *
 * Deletions are scoped to entries whose parent is FAVORITES_GROUP, so this
 * cannot affect any other group.
 */
function applyFavoritesFromToolbar(data: Sync): boolean {
    const folder = browserBookmarkFolders.find((f) => f.title === FAVORITES_GROUP)

    if (!folder) {
        return false
    }

    data.linkgroups.bookmarkFolders[FAVORITES_GROUP] = folder.id

    return mirrorFolderIntoGroup(data, FAVORITES_GROUP, folder.bookmarks)
}

/**
 * Replace the contents of `group` in `data` with `bookmarks`, preserving
 * existing _id when a URL already exists locally. Returns true when something
 * actually changed.
 *
 * Chrome Bookmarks is the source of truth for mirrored groups. Local hidden
 * entries from older two-way sync versions are ignored so the full browser
 * bookmark state is rendered.
 */
function mirrorFolderIntoGroup(
    data: Sync,
    group: string,
    bookmarks: BookmarksFolderItem[],
): boolean {
    let mutated = false
    const sourceBookmarks = uniqueBookmarksByUrl(bookmarks)

    // Snapshot existing links in this group, indexed by browser bookmark id.
    // URL matching is kept only as a migration fallback for older configs.
    const existingByUrl = new Map<string, LinkElem>()
    const existingByBookmarkId = new Map<string, LinkElem>()
    const existingKeys: string[] = []

    for (const [key, val] of Object.entries(data)) {
        if (isLink(val) && isElem(val) && val.parent === group) {
            if (val.bookmark?.id) {
                existingByBookmarkId.set(val.bookmark.id, val)
            } else {
                existingByUrl.set(val.url, val)
            }
            existingKeys.push(key)
        }
    }

    const incomingUrls = new Set(sourceBookmarks.map((b) => normalizeBookmarkUrl(b.url)))
    const incomingIds = new Set(sourceBookmarks.map((b) => b.id))

    // Remove links that are no longer in the source folder.
    for (const key of existingKeys) {
        const link = data[key] as LinkElem
        const stillInBrowser = link.bookmark?.id
            ? incomingIds.has(link.bookmark.id)
            : incomingUrls.has(normalizeBookmarkUrl(link.url))

        if (!stillInBrowser) {
            delete data[key]
            mutated = true
        }
    }

    // Add or update links from the source folder, in source order.
    for (let i = 0; i < sourceBookmarks.length; i++) {
        const bookmark = sourceBookmarks[i]

        let existing = existingByBookmarkId.get(bookmark.id)

        if (!existing) {
            existing = existingByUrl.get(bookmark.url)
            existingByUrl.delete(bookmark.url)
        }

        if (existing) {
            const titleChanged = existing.title !== bookmark.title
            const urlChanged = existing.url !== bookmark.url
            const orderChanged = existing.order !== i
            const bookmarkChanged = existing.bookmark?.id !== bookmark.id ||
                existing.bookmark?.parentId !== bookmark.parentId

            if (titleChanged || urlChanged || orderChanged || bookmarkChanged) {
                existing.title = bookmark.title
                existing.url = bookmark.url
                existing.order = i
                existing.bookmark = {
                    id: bookmark.id,
                    parentId: bookmark.parentId,
                }
                data[existing._id] = existing
                mutated = true
            }
        } else {
            const link = validateLink(bookmark.title, bookmark.url, group)
            link.order = i
            link.bookmark = {
                id: bookmark.id,
                parentId: bookmark.parentId,
            }
            data[link._id] = link
            mutated = true
        }
    }

    return mutated
}

// Auto-sync: listen for Chrome bookmark changes and re-sync synced groups

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
        // Cannot read the tree right now; do not touch local data.
        return
    }

    browserBookmarkFolders = bookmarkTreeToFolderList(treenode[0])
    ensureBookmarkFolderRefs(data)

    let mutated = applySyncedGroups(data)

    // The favorites bar always tracks the toolbar, even with no named synced groups.
    mutated = applyFavoritesFromToolbar(data) || mutated

    if (!mutated) {
        return
    }

    await storage.sync.set(data)
    const local = await storage.local.get()
    initGroups(data)
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
    const groups = collectRestorableBookmarkGroups(data)

    if (!EXTENSION || groups.size === 0) {
        return false
    }

    holdBookmarkRefreshes()

    let treenode = await getBookmarkTree()

    if (!treenode) {
        try {
            await getPermissions('bookmarks')
            treenode = await getBookmarkTree()
        } catch (_error) {
            settingsNotifications({ 'accept-permissions': true })
            releaseBookmarkRefreshesSoon()
            return false
        }
    }

    const root = treenode?.[0]

    if (!root) {
        releaseBookmarkRefreshesSoon()
        return false
    }

    const bookmarksApi = EXTENSION.bookmarks

    if (!bookmarksApi) {
        releaseBookmarkRefreshesSoon()
        return false
    }

    const toolbar = root.children?.[0] ?? root
    const folderIdsByTitle = bookmarkFolderIdsByTitle(root)
    const urlsByParentId = directBookmarkUrlsByParentId(root)
    let createdAny = false

    for (const [group, links] of orderedRestorableGroups(data, groups)) {
        const parentId = group === FAVORITES_GROUP
            ? toolbar.id
            : await getOrCreateRestoreFolder(group, toolbar.id, bookmarksApi, folderIdsByTitle, urlsByParentId)

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
                await bookmarksApi.create({
                    parentId,
                    title: link.title,
                    url,
                })
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
    const desiredGroups = collectRestorableBookmarkGroups(next)
    const currentGroups = collectRestorableBookmarkGroups(current)

    if (!EXTENSION || !EXTENSION.bookmarks) {
        return false
    }

    holdBookmarkRefreshes()

    let treenode = await getBookmarkTree()

    if (!treenode) {
        try {
            await getPermissions('bookmarks')
            treenode = await getBookmarkTree()
        } catch (_error) {
            settingsNotifications({ 'accept-permissions': true })
            releaseBookmarkRefreshesSoon()
            return false
        }
    }

    const root = treenode?.[0]

    if (!root) {
        releaseBookmarkRefreshesSoon()
        return false
    }

    const bookmarksApi = EXTENSION.bookmarks
    const toolbar = root.children?.[0] ?? root
    const folderIdsByTitle = bookmarkFolderIdsByTitle(root)
    const bookmarksByParentId = directBookmarksByParentId(root)
    const targetGroups = uniqueStrings([...currentGroups.keys(), ...desiredGroups.keys()])
    let mutated = false

    for (const group of orderedRestorableGroupNames(next, desiredGroups, targetGroups)) {
        const desiredLinks = desiredGroups.get(group) ?? []
        const parentId = group === FAVORITES_GROUP
            ? toolbar.id
            : await getOrCreateRestoreFolder(group, toolbar.id, bookmarksApi, folderIdsByTitle, new Map())

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
                    await bookmarksApi.create({
                        parentId,
                        index,
                        title: link.title,
                        url,
                    })
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
        return update.addLinks.some((link) => isSyncedBookmarkGroup(data, link.group ?? data.linkgroups.selected))
    }

    if (update.updateLink) {
        return isMirroredBookmarkLink(data[update.updateLink.id], data)
    }

    if (update.deleteLinks) {
        return update.deleteLinks.some((id) => isMirroredBookmarkLink(data[id], data))
    }

    if (update.moveLinks) {
        return update.moveLinks.some((id) => isMirroredBookmarkLink(data[id], data))
    }

    if (update.moveFavorites) {
        return true
    }

    if (update.moveToGroup) {
        return isSyncedBookmarkGroup(data, update.moveToGroup.target) ||
            update.moveToGroup.ids.some((id) => isMirroredBookmarkLink(data[id], data))
    }

    if (update.moveToFolder) {
        return isMirroredBookmarkLink(data[update.moveToFolder.source], data)
    }

    if (update.moveOutFolder) {
        return isSyncedBookmarkGroup(data, update.moveOutFolder.group) ||
            update.moveOutFolder.ids.some((id) => isMirroredBookmarkLink(data[id], data))
    }

    if (update.groupTitle) {
        return isSyncedBookmarkGroup(data, update.groupTitle.old) ||
            isSyncedBookmarkGroup(data, update.groupTitle.new)
    }

    if (update.deleteGroup) {
        return isSyncedBookmarkGroup(data, update.deleteGroup)
    }

    if (update.moveGroups) {
        return update.moveGroups.some((group) => isSyncedBookmarkGroup(data, group))
    }

    if (update.unsyncGroup) {
        return isSyncedBookmarkGroup(data, update.unsyncGroup)
    }

    return false
}

function isSyncedBookmarkGroup(data: Sync, group?: string): boolean {
    return group === FAVORITES_GROUP || !!group && data.linkgroups.synced.includes(group)
}

function isMirroredBookmarkLink(link: unknown, data: Sync): link is LinkElem {
    if (!isLink(link) || !isElem(link)) {
        return false
    }

    const elem = link as LinkElem

    return !!elem.bookmark?.id || isSyncedBookmarkGroup(data, elem.parent)
}

function ensureBookmarkFolderRefs(data: Sync): void {
    data.linkgroups.bookmarkFolders ??= {}

    for (const folder of browserBookmarkFolders) {
        data.linkgroups.bookmarkFolders[folder.title] = folder.id
    }

    const favorites = browserBookmarkFolders.find((f) => f.title === FAVORITES_GROUP)
    if (favorites) {
        data.linkgroups.bookmarkFolders[FAVORITES_GROUP] = favorites.id
    }
}

function collectRestorableBookmarkGroups(data: Sync): Map<string, LinkElem[]> {
    const groups = new Map<string, LinkElem[]>()
    const folderGroupById = new Map(
        Object.entries(data.linkgroups.bookmarkFolders ?? {}).map(([group, folderId]) => [folderId, group]),
    )

    for (const value of Object.values(data)) {
        if (!isLink(value) || !isElem(value)) {
            continue
        }

        const group = restorableBookmarkGroup(value, data, folderGroupById)

        if (!group) {
            continue
        }

        const links = groups.get(group) ?? []
        links.push(value)
        groups.set(group, links)
    }

    for (const [group, links] of groups) {
        groups.set(group, uniqueRestorableBookmarks(links))
    }

    return groups
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

function orderedRestorableGroups(data: Sync, groups: Map<string, LinkElem[]>): [string, LinkElem[]][] {
    return orderedRestorableGroupNames(data, groups).map((group) => [group, groups.get(group) ?? []])
}

function orderedRestorableGroupNames(data: Sync, groups: Map<string, LinkElem[]>, extras: string[] = []): string[] {
    const configuredGroups = data.linkgroups.groups.filter((group) => groups.has(group) || extras.includes(group))
    const extraGroups = uniqueStrings([...groups.keys(), ...extras]).filter((group) => {
        return group !== FAVORITES_GROUP && !configuredGroups.includes(group)
    })
    const favorites = groups.has(FAVORITES_GROUP) || extras.includes(FAVORITES_GROUP) ? [FAVORITES_GROUP] : []

    return [...configuredGroups, ...extraGroups, ...favorites]
}

function restorableBookmarkGroup(
    link: LinkElem,
    data: Sync,
    folderGroupById: Map<string, string>,
): string | undefined {
    const parent = typeof link.parent === 'string' ? link.parent : undefined

    if (parent === FAVORITES_GROUP) {
        return FAVORITES_GROUP
    }

    if (parent && data.linkgroups.synced.includes(parent)) {
        return parent
    }

    if (link.bookmark?.parentId) {
        const group = folderGroupById.get(link.bookmark.parentId)

        if (group) {
            return group
        }
    }

    if (parent && !parent.startsWith('links')) {
        return parent
    }
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

function uniqueRestorableBookmarks(links: LinkElem[]): LinkElem[] {
    const seenUrls = new Set<string>()
    const unique: LinkElem[] = []

    for (const link of links.toSorted((a, b) => a.order - b.order)) {
        const url = normalizeBookmarkUrl(link.url)

        if (!url || seenUrls.has(url)) {
            continue
        }

        seenUrls.add(url)
        unique.push(link)
    }

    return unique
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
        const folder = await bookmarksApi.create({
            parentId: toolbarId,
            title,
        })

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
        const base = path.join(' / ') || 'Default group'
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
        const currentPath = isRootNode || isToolbarNode ? path : [...path, node.title || 'Default group']

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

// webext stuff

/**
 * Always prefer the live bookmark tree from the API. The cached
 * `startupBookmarks` is only used as a synchronous fallback when the API call
 * itself fails or is unavailable, never as the primary source. This avoids
 * the "first call wins, subsequent calls get nothing" race that used to leave
 * the favorites bar empty on refresh.
 */
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
        const base = path.join(' / ') || 'Default group'
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

            if (mapped) {
                directBookmarks.push(mapped)
            }
        }

        // Always register the favorites bucket, even when empty. The favorites
        // bar is a strict mirror of the toolbar's direct links: when the user
        // removes the last toolbar link, the bar must clear too. Returning
        // early here used to leave stale local data untouched and broke that
        // contract.
        folders[FAVORITES_GROUP] = {
            id: toolbar?.id ?? FAVORITES_GROUP,
            title: FAVORITES_GROUP,
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
        const currentPath = isRootNode || isToolbarNode ? path : [...path, node.title || 'Default group']
        const directBookmarks: BookmarksFolderItem[] = []

        for (const child of node.children) {
            const bookmark = mapBookmark(child)

            if (bookmark) {
                directBookmarks.push(bookmark)
            }
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

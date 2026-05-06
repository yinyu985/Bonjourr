import { FAVORITES_GROUP, initblocks, quickLinks, validateLink } from './index.ts'
import { isElem, isLink } from './helpers.ts'

import { EXTENSION } from '../../defaults.ts'
import { getHTMLTemplate, toggleDisabled } from '../../shared/dom.ts'
import { getLang, tradThis, traduction } from '../../utils/translations.ts'
import { settingsNotifications } from '../../utils/notifications.ts'
import { getPermissions } from '../../utils/permissions.ts'
import { randomString } from '../../shared/generic.ts'
import { onclickdown } from 'clickdown/mod'
import { storage } from '../../storage.ts'

import type { Link, LinkElem } from '../../../types/shared.ts'
import type { Sync } from '../../../types/sync.ts'

type Treenode = browser.bookmarks.BookmarkTreeNode

type BookmarksFolder = {
    title: string
    displayTitle?: string
    bookmarks: BookmarksFolderItem[]
}

type BookmarksFolderItem = {
    id: string
    title: string
    url: string
    dateAdded: number
}

let browserBookmarkFolders: BookmarksFolder[] = []
let bookmarkListenerAdded = false

export async function linksImport(): Promise<void> {
    const data = await storage.sync.get()

    for (const node of document.querySelectorAll('#bookmarks-container > *') ?? []) {
        node.remove()
    }

    // Reset bookmark folders before fetching fresh data
    browserBookmarkFolders = []

    await initBookmarkSync(data)
    await createBookmarksDialog()
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

    // Self-heal: __favorites must never live in linkgroups.synced.
    const filteredSynced = data.linkgroups.synced.filter((group) => group !== FAVORITES_GROUP)
    let mutated = filteredSynced.length !== data.linkgroups.synced.length
    data.linkgroups.synced = filteredSynced

    // 1. Mirror named synced groups (real folders the user opted to sync).
    if (data.linkgroups.synced.length > 0) {
        mutated = applySyncedGroups(data) || mutated
    }

    // 2. Always mirror toolbar direct links into the implicit __favorites bucket.
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

    for (const group of data.linkgroups.synced) {
        if (group === FAVORITES_GROUP) {
            // Defensive: __favorites is handled by applyFavoritesFromToolbar.
            continue
        }

        const folder = browserBookmarkFolders.find((f) => f.title === group)

        if (!folder) {
            // Source folder is currently unavailable — keep local links intact.
            continue
        }

        if (mirrorFolderIntoGroup(data, group, folder.bookmarks)) {
            mutated = true
        }
    }

    return mutated
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

    return mirrorFolderIntoGroup(data, FAVORITES_GROUP, folder.bookmarks)
}

/**
 * Replace the contents of `group` in `data` with `bookmarks`, preserving
 * existing _id when a URL already exists locally. Returns true when something
 * actually changed.
 *
 * URLs listed in `linkgroups.hidden[group]` are skipped: the user explicitly
 * moved them out of this synced group and we must not re-add them.
 */
function mirrorFolderIntoGroup(
    data: Sync,
    group: string,
    bookmarks: BookmarksFolderItem[],
): boolean {
    const hiddenUrls = data.linkgroups.hidden[group] ?? []
    let mutated = false

    // Snapshot existing links in this group, indexed by URL, before mutation.
    const existingByUrl = new Map<string, LinkElem>()
    const existingKeys: string[] = []

    for (const [key, val] of Object.entries(data)) {
        if (isLink(val) && isElem(val) && val.parent === group) {
            existingByUrl.set(val.url, val)
            existingKeys.push(key)
        }
    }

    const incomingUrls = new Set(
        bookmarks.filter((b) => !hiddenUrls.includes(b.url)).map((b) => b.url),
    )

    // Remove links that are no longer in the source folder.
    for (const key of existingKeys) {
        const link = data[key] as LinkElem
        if (!incomingUrls.has(link.url)) {
            delete data[key]
            mutated = true
        }
    }

    // Add or update links from the source folder, in source order.
    for (let i = 0; i < bookmarks.length; i++) {
        const bookmark = bookmarks[i]

        if (hiddenUrls.includes(bookmark.url)) {
            continue
        }

        const existing = existingByUrl.get(bookmark.url)

        if (existing) {
            const titleChanged = existing.title !== bookmark.title
            const orderChanged = existing.order !== i

            if (titleChanged || orderChanged) {
                existing.title = bookmark.title
                existing.order = i
                data[existing._id] = existing
                mutated = true
            }
        } else {
            const link = validateLink(bookmark.title, bookmark.url, group)
            link.order = i
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
            refreshSyncedGroups()
        })
    }
}

async function refreshSyncedGroups(): Promise<void> {
    const data = await storage.sync.get()
    const treenode = await getBookmarkTree()

    if (!treenode) {
        // Cannot read the tree right now; do not touch local data.
        return
    }

    browserBookmarkFolders = bookmarkTreeToFolderList(treenode[0])

    let mutated = false

    if (data.linkgroups.synced.length > 0) {
        mutated = applySyncedGroups(data) || mutated
    }

    // The favorites bar always tracks the toolbar, even with no named synced groups.
    mutated = applyFavoritesFromToolbar(data) || mutated

    if (!mutated) {
        return
    }

    await storage.sync.set(data)
    const local = await storage.local.get()
    initblocks(data, local)
}

// Bookmarks Dialog

async function createBookmarksDialog(): Promise<void> {
    const bookmarkFolders = browserBookmarkFolders
    const data = await storage.sync.get()

    let bookmarksdom = document.querySelector<HTMLDialogElement>('#bookmarks')
    let container = document.querySelector<HTMLElement>('#bookmarks-container')

    if (!bookmarksdom) {
        bookmarksdom = getHTMLTemplate<HTMLDialogElement>('bookmarks-dialog-template', 'dialog')
        container = bookmarksdom.querySelector('#bookmarks-container')

        const closebutton = bookmarksdom.querySelector<HTMLButtonElement>('#bmk_close')
        const applybutton = bookmarksdom.querySelector<HTMLButtonElement>('#bmk_apply')
        const selectallbutton = bookmarksdom.querySelector<HTMLButtonElement>('#bmk_selectall')
        const syncallbutton = bookmarksdom.querySelector<HTMLButtonElement>('#bmk_syncall')

        bookmarksdom?.addEventListener('click', closeDialog)
        onclickdown(applybutton, importSelectedBookmarks)
        onclickdown(closebutton, closeDialog)
        onclickdown(selectallbutton, selectAllFolders)
        onclickdown(syncallbutton, syncAllFolders)

        document.body.appendChild(bookmarksdom)
    }

    for (const folder of bookmarkFolders) {
        const folderEl = getHTMLTemplate<HTMLDivElement>('bookmarks-folder-template', 'div')
        const selectButton = folderEl.querySelector('.b_bookmarks-folder-select')
        const syncButton = folderEl.querySelector('.b_bookmarks-folder-sync')
        const h2 = folderEl.querySelector('.bookmarks-folder-title-content')

        if (!h2) {
            continue
        }

        h2.textContent = folder.displayTitle ?? folder.title
        folderEl.dataset.title = folder.title

        if (data.linkgroups.synced.includes(folder.title)) {
            folderEl.classList.add('synced')
        }

        onclickdown(selectButton, () => toggleFolderSelect(folderEl))
        onclickdown(syncButton, () => toggleFolderSync(folderEl))
        container?.appendChild(folderEl)
    }

    document.getElementById('bmk_apply')?.setAttribute('disabled', '')
    document.dispatchEvent(new CustomEvent('toggle-settings'))
    traduction(bookmarksdom, getLang())

    bookmarksdom.showModal()
    setTimeout(() => bookmarksdom.classList.add('shown'))
}

async function importSelectedBookmarks(): Promise<void> {
    const folders = browserBookmarkFolders
    const bookmarksdom = document.getElementById('bookmarks') as HTMLDialogElement
    const selectedFolders = bookmarksdom.querySelectorAll<HTMLDivElement>('.bookmarks-folder.selected')
    const syncedFolders = bookmarksdom.querySelectorAll<HTMLDivElement>('.bookmarks-folder.synced')
    const folderIds = [...selectedFolders].map((el) => el.dataset.title ?? '')
    // __favorites is implicit; it must never be tracked as a synced group.
    const syncedIds = [...syncedFolders]
        .map((el) => el.dataset.title ?? '')
        .filter((id) => id !== FAVORITES_GROUP)

    const links: { title: string; url: string; group?: string }[] = []
    const groups: { title: string; sync: boolean }[] = []

    const data = await storage.sync.get()

    const existingUrls = new Set<string>()
    for (const val of Object.values(data)) {
        if (isLink(val) && isElem(val as Link)) {
            existingUrls.add((val as LinkElem).url)
        }
    }

    for (const folder of folders) {
        const isFolderSelected = folderIds.includes(folder.title)
        const isFolderSynced = syncedIds.includes(folder.title)
        // Toolbar direct links (__favorites) never become a user group; they're
        // mirrored into the favorites bar instead.
        const isFavoritesBucket = folder.title === FAVORITES_GROUP

        if (isFolderSelected && !isFavoritesBucket) {
            groups.push({
                title: folder.title,
                sync: isFolderSynced,
            })
        }

        for (const bookmark of folder.bookmarks) {
            if (!isFolderSelected || existingUrls.has(bookmark.url)) {
                continue
            }

            existingUrls.add(bookmark.url)
            links.push({
                title: bookmark.title,
                url: bookmark.url,
                // Imported toolbar direct links go straight to the favorites bar.
                group: isFavoritesBucket ? FAVORITES_GROUP : folder.title,
            })
        }
    }

    const iLinkgroups = document.querySelector<HTMLInputElement>('#i_linkgroups')
    const allGroups = [...groups, ...data.linkgroups.groups]
    const toggleGroups = allGroups.length > 1

    await quickLinks(undefined, {
        groups: toggleGroups,
        addLinks: links,
        addGroups: groups,
    })

    if (iLinkgroups) {
        iLinkgroups.checked = toggleGroups
    }

    const newData = await storage.sync.get()
    const selectedSet = new Set(folderIds)
    const syncedSet = new Set(syncedIds)

    // Drop synced flags for groups we're re-importing, then re-add the ones
    // the user explicitly opted to sync. __favorites is intentionally excluded
    // (filtered out of syncedIds above).
    newData.linkgroups.synced = newData.linkgroups.synced.filter((group) =>
        selectedSet.has(group) === false && group !== FAVORITES_GROUP
    )

    for (const group of syncedSet) {
        if (newData.linkgroups.synced.includes(group) === false) {
            newData.linkgroups.synced.push(group)
        }
    }

    await storage.sync.set(newData)

    // Mirror once more so newly synced groups (and the favorites bar) are
    // up-to-date before we hand control back to the rendered UI.
    const refreshed = await initBookmarkSync(newData)
    const local = await storage.local.get()
    initblocks(refreshed, local)

    bookmarksdom?.classList.remove('shown')
    bookmarksdom?.close()
    closeDialog()
}

function handleApplyButtonText(): void {
    const applybutton = document.getElementById('bmk_apply') as HTMLElement
    const syncallbutton = document.getElementById('bmk_syncall') as HTMLElement
    const folders = document.querySelectorAll('#bookmarks .bookmarks-folder.selected')
    const emptySelection = folders.length === 0

    toggleDisabled(applybutton, emptySelection)
    toggleDisabled(syncallbutton, emptySelection)
}

function selectAllFolders(): void {
    const bookmarksdom = document.getElementById('bookmarks')
    const folders = bookmarksdom?.querySelectorAll<HTMLDivElement>('.bookmarks-folder') ?? []
    const allSelected = folders.length > 0 && [...folders].every((f) => f.classList.contains('selected'))

    for (const folder of folders) {
        const syncButton = folder.querySelector('.b_bookmarks-folder-sync')

        if (allSelected) {
            folder.classList.remove('selected')
            folder.classList.remove('synced')
            syncButton?.classList.remove('selected')
            syncButton?.setAttribute('disabled', '')
        } else {
            folder.classList.add('selected')
            syncButton?.removeAttribute('disabled')
        }
    }

    handleApplyButtonText()
}

function syncAllFolders(): void {
    const bookmarksdom = document.getElementById('bookmarks')
    const selectedFolders = bookmarksdom?.querySelectorAll<HTMLDivElement>('.bookmarks-folder.selected') ?? []
    const allSynced = selectedFolders.length > 0 && [...selectedFolders].every((f) => f.classList.contains('synced'))

    for (const folder of selectedFolders) {
        if (allSynced) {
            folder.classList.remove('synced')
        } else {
            folder.classList.add('synced')
        }
    }
}

function closeDialog(event?: Event): void {
    const path = (event?.composedPath() ?? []) as Element[]
    const id = path[0]?.id ?? ''

    if (!event || id === 'bookmarks' || id === 'bmk_close') {
        const bookmarksdom = document.querySelector<HTMLDialogElement>('#bookmarks')

        bookmarksdom?.close()
        bookmarksdom?.classList.remove('shown')
        for (const node of bookmarksdom?.querySelectorAll('.selected') ?? []) {
            node.classList.remove('selected')
        }
    }
}

function toggleFolderSelect(folder: HTMLElement): void {
    const selectButton = folder.querySelector('.b_bookmarks-folder-select')
    const syncButton = folder.querySelector('.b_bookmarks-folder-sync')

    if (!selectButton) {
        return
    }

    if (folder.classList.contains('selected')) {
        folder.classList.remove('selected')
        syncButton?.classList.remove('selected')
        syncButton?.setAttribute('disabled', '')
    } else {
        folder.classList.add('selected')
        syncButton?.removeAttribute('disabled')
    }

    handleApplyButtonText()
}

function toggleFolderSync(folder: HTMLElement): void {
    if (folder.classList.contains('synced')) {
        folder.classList.remove('synced')
    } else {
        folder.classList.add('synced')
    }
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

    function mapBookmark(node: Treenode): BookmarksFolderItem | undefined {
        if (!node.url) {
            return
        }

        return {
            id: randomString(6),
            title: node.title ?? '',
            url: node.url,
            dateAdded: node.dateAdded ?? 0,
        }
    }

    function uniqueBookmarks(bookmarks: BookmarksFolderItem[]): BookmarksFolderItem[] {
        const seen = new Set<string>()
        const unique: BookmarksFolderItem[] = []

        for (const bookmark of bookmarks) {
            if (seen.has(bookmark.url)) {
                continue
            }

            seen.add(bookmark.url)
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
            title: FAVORITES_GROUP,
            displayTitle: tradThis('Bookmarks bar'),
            bookmarks: uniqueBookmarks(directBookmarks),
        }
    }

    function createMapFromTree(node: Treenode): void {
        if (!node.children) {
            return
        }

        const folderTitle = node.title || 'Default group'
        const isRootNode = !node.title
        const isToolbarNode = node.id === treenode.children?.[0]?.id
        const directBookmarks: BookmarksFolderItem[] = []

        for (const child of node.children) {
            const bookmark = mapBookmark(child)

            if (bookmark) {
                directBookmarks.push(bookmark)
            }
        }

        const uniqueDirectBookmarks = uniqueBookmarks(directBookmarks)

        if (!isRootNode && !isToolbarNode && uniqueDirectBookmarks.length > 0) {
            folders[folderTitle] = {
                title: folderTitle,
                bookmarks: uniqueDirectBookmarks,
            }
        }

        for (const child of node.children) {
            if (child.children) {
                createMapFromTree(child)
            }
        }
    }

    addToolbarDirectLinksToFavorites(treenode)
    createMapFromTree(treenode)

    return Object.values(folders)
}

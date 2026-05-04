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

export async function initBookmarkSync(data: Sync): Promise<void> {
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
        return
    }

    browserBookmarkFolders = bookmarkTreeToFolderList(treenode[0])

    // If there are synced groups, update their data from browser bookmarks
    if (data.linkgroups.synced.length > 0) {
        const updated = applySyncedGroups(data)
        await storage.sync.set(updated)
    }

    addBookmarkListeners()
}

// For synced groups: replace their links entirely with current browser bookmarks
// Matching by URL to reuse existing _id where possible
function applySyncedGroups(data: Sync): Sync {
    for (const group of data.linkgroups.synced) {
        const folder = browserBookmarkFolders.find((f) => f.title === group)
        const hiddenUrls = data.linkgroups.hidden[group] ?? []

        // Build a map of existing links in this group by URL BEFORE removing them
        const existingByUrl = new Map<string, LinkElem>()
        for (const val of Object.values(data)) {
            if (isLink(val) && isElem(val as Link) && (val as LinkElem).parent === group) {
                existingByUrl.set((val as LinkElem).url, val as LinkElem)
            }
        }

        // Remove all old links from this synced group (they're stale)
        for (const [key, val] of Object.entries(data)) {
            if (isLink(val) && (val as Link).parent === group) {
                delete data[key]
            }
        }

        if (!folder) {
            continue
        }

        // Add fresh browser bookmarks, reusing existing _id where URL matches
        // Skip bookmarks whose URLs have been moved out (hidden)
        for (let i = 0; i < folder.bookmarks.length; i++) {
            const bookmark = folder.bookmarks[i]

            if (hiddenUrls.includes(bookmark.url)) {
                continue
            }

            const existing = existingByUrl.get(bookmark.url)

            if (existing) {
                existing.title = bookmark.title
                existing.order = i
                data[existing._id] = existing
            } else {
                const link = validateLink(bookmark.title, bookmark.url, group)
                link.order = i
                data[link._id] = link
            }
        }
    }

    return data
}

export function syncBookmarks(group: string, data?: Sync): Link[] {
    const folder = browserBookmarkFolders.find((folder) => folder.title === group)
    const syncedLinks: Link[] = []

    if (folder) {
        for (const bookmark of folder.bookmarks) {
            const link = validateLink(bookmark.title, bookmark.url, group)

            if (data) {
                for (const val of Object.values(data)) {
                    if (isLink(val) && isElem(val) && val.url === bookmark.url && val.parent === group) {
                        link._id = val._id
                        break
                    }
                }
            }

            syncedLinks.push(link)
        }
    }

    return syncedLinks
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

    if (data.linkgroups.synced.length === 0) {
        return
    }

    const treenode = await getBookmarkTree()

    if (treenode) {
        browserBookmarkFolders = bookmarkTreeToFolderList(treenode[0])
    }

    // Update storage data for synced groups (removes deleted bookmarks, adds new ones)
    const updated = applySyncedGroups(data)
    await storage.sync.set(updated)

    const local = await storage.local.get()
    initblocks(updated, local)
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
    const syncedIds = [...syncedFolders].map((el) => el.dataset.title ?? '')

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

        if (isFolderSelected && folder.title !== FAVORITES_GROUP) {
            groups.push({
                title: folder.title,
                sync: isFolderSynced,
            })
        }

        for (const bookmark of folder.bookmarks) {
            if (isFolderSelected && !existingUrls.has(bookmark.url)) {
                existingUrls.add(bookmark.url)
                links.push({
                    title: bookmark.title,
                    url: bookmark.url,
                    group: folder.title,
                })
            }
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

    newData.linkgroups.synced = newData.linkgroups.synced.filter((group) => selectedSet.has(group) === false)

    for (const group of syncedSet) {
        if (newData.linkgroups.synced.includes(group) === false) {
            newData.linkgroups.synced.push(group)
        }
    }

    await storage.sync.set(newData)

    if (syncedIds.length > 0) {
        await initBookmarkSync(newData)
    }

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

async function getBookmarkTree(): Promise<Treenode[] | undefined> {
    let treenode = globalThis.startupBookmarks

    // Clear startup cache after first use so subsequent calls always get fresh data
    if (treenode) {
        globalThis.startupBookmarks = undefined
    }

    if (!treenode) {
        treenode = await EXTENSION?.bookmarks?.getTree() as browser.bookmarks.BookmarkTreeNode[]
    }

    if (!treenode) {
        return
    }

    return treenode
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

        if (!toolbar?.children) {
            return
        }

        const directBookmarks: BookmarksFolderItem[] = []

        for (const child of toolbar.children) {
            const mapped = mapBookmark(child)

            if (mapped) {
                directBookmarks.push(mapped)
            }
        }

        const unique = uniqueBookmarks(directBookmarks)

        if (unique.length === 0) {
            return
        }

        folders[FAVORITES_GROUP] = {
            title: FAVORITES_GROUP,
            displayTitle: tradThis('Bookmarks bar'),
            bookmarks: unique,
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

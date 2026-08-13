import { initblocks, initFavorites } from './index.ts'

import { transitioner } from '../../utils/transitioner.ts'
import { tradThis } from '../../utils/translations.ts'
import { storage } from '../../storage.ts'

import { linksWithBookmarks, syncWithBookmarks } from './model.ts'

import type { Sync, SyncSnapshot } from '../../../types/sync.ts'

const domlinkblocks = document.getElementById('linkblocks') as HTMLDivElement
let positionListenerAdded = false

export function isGroupFocus(): boolean {
    return document.body.classList.contains('group-focus')
}

export function setGroupFocus(focused: boolean): void {
    document.body.classList.toggle('group-focus', focused)

    if (focused) {
        const container = document.getElementById('link-favorites')
        const hasRendered = container && container.children.length > 0

        if (!hasRendered) {
            import('./bookmarks.ts').then(async ({ buildBookmarkSnapshotFromConfig }) => {
                initFavorites(await buildBookmarkSnapshotFromConfig(await storage.sync.get()))
            }).catch((err) => {
                console.warn('Cannot refresh bookmarks before opening folders', err)
            })
        }
    }
}

export function initFolders(data: SyncSnapshot, init?: true): void {
    if (!init) {
        for (const node of document.querySelectorAll('#link-mini button') ?? []) {
            node.remove()
        }
    }

    createFolderTabs(data)
    updateSelectedFolderPosition()

    if (!positionListenerAdded) {
        positionListenerAdded = true
        globalThis.addEventListener('resize', updateSelectedFolderPosition)
    }
}

function createFolderTabs(data: SyncSnapshot): void {
    const links = linksWithBookmarks(data)
    const visibleFolders = links.folders

    for (const folder of visibleFolders) {
        const button = document.createElement('button')
        const isTopSite = folder.id === 'topsites'
        button.textContent = folder.title
        button.dataset.group = folder.id
        button.classList.add('link-title')
        button.classList.toggle('selected-group', folder.id === links.selectedFolder)
        button.classList.remove('synced')

        if (isTopSite) {
            button.textContent = tradThis('Most visited')
            button.classList.add('topsites-title')
        }

        button.addEventListener('click', changeFolder)

        document.querySelector('#link-mini div')?.appendChild(button)
    }

    domlinkblocks?.classList.toggle('with-groups', links.foldersOn && links.folders.length > 0)

    if (!links.foldersOn || links.folders.length === 0) {
        setGroupFocus(false)
    }
}

function changeFolder(event: Event): void {
    const button = event.currentTarget as HTMLButtonElement

    if (!button) {
        return
    }

    const transition = transitioner()

    if (domlinkblocks.dataset.folderid) {
        return
    }

    if (button.classList.contains('selected-group')) {
        setGroupFocus(!isGroupFocus())
        updateSelectedFolderPosition()
        return
    }

    transition.first(hideCurrentFolder)
    transition.after(recreateLinksFromNewFolder)
    transition.finally(showNewFolder)
    void transition.transition(100).catch((err) => console.warn('Cannot switch bookmark folder', err))

    async function recreateLinksFromNewFolder(): Promise<void> {
        const buttons = document.querySelectorAll<HTMLElement>('#link-mini button')
        const data = await refreshBookmarksBeforeFolderRender(await storage.sync.get())
        const links = linksWithBookmarks(data)
        const folderId = button.dataset.group ?? links.folders[0]?.id ?? ''

        for (const div of buttons ?? []) {
            div.classList.remove('selected-group')
        }
        button.classList.add('selected-group')
        await storage.sync.update((current) => {
            current.links.selectedFolder = folderId
        })
        data.links.selectedFolder = folderId
        initblocks(data)
    }

    function hideCurrentFolder(): void {
        setGroupFocus(false)
        domlinkblocks.classList.remove('in-folder')
        domlinkblocks.classList.add('hiding')
    }

    function showNewFolder(): void {
        domlinkblocks.classList.remove('hiding')
        setGroupFocus(true)
        updateSelectedFolderPosition()
    }
}

async function refreshBookmarksBeforeFolderRender(data: Sync): Promise<SyncSnapshot> {
    try {
        const { buildBookmarkSnapshotFromConfig } = await import('./bookmarks.ts')
        return await buildBookmarkSnapshotFromConfig(data)
    } catch (_) {
        return syncWithBookmarks(data)
    }
}

export function updateSelectedFolderPosition(): void {
    const selected = document.querySelector<HTMLElement>('#link-mini .link-title.selected-group')
    const linkblocks = document.getElementById('linkblocks')

    if (!(selected && linkblocks)) {
        return
    }

    const selectedRect = selected.getBoundingClientRect()
    const blocksRect = linkblocks.getBoundingClientRect()
    const center = selectedRect.left + selectedRect.width / 2 - blocksRect.left

    linkblocks.style.setProperty('--active-group-x', `${Math.round(center)}px`)
}

export function toggleFolders(on: boolean, data: Sync): Sync {
    domlinkblocks?.classList.toggle('with-groups', on)
    setGroupFocus(false)
    data.links.foldersOn = on
    return data
}

export function changeFolderTitle(title: { old: string; new: string }, data: Sync): Sync {
    if (!title.old && !title.new) {
        initFolders(syncWithBookmarks(data))
        return data
    }

    const folder = linksWithBookmarks(data).folders.find((item) => item.id === title.old || item.title === title.old)

    if (!folder) {
        return data
    }

    folder.title = title.new
    data.links.selectedFolder = folder.id
    initFolders(syncWithBookmarks(data))
    return data
}

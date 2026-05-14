import { initblocks, initFavorites } from './index.ts'

import { transitioner } from '../../utils/transitioner.ts'
import { tradThis } from '../../utils/translations.ts'
import { storage } from '../../storage.ts'

import type { Sync } from '../../../types/sync.ts'

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
            storage.sync.get().then((data) => initFavorites(data))
        }
    }
}

export function initFolders(data: Sync, init?: true): void {
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

function createFolderTabs(data: Sync): void {
    const visibleFolders = data.links.folders

    for (const folder of visibleFolders) {
        const button = document.createElement('button')
        const isTopSite = folder.id === 'topsites'
        const isDefault = folder.id === 'default'
        button.textContent = folder.title
        button.dataset.group = folder.id
        button.classList.add('link-title')
        button.classList.toggle('selected-group', folder.id === data.links.selectedFolder)
        button.classList.toggle('synced', folder.source === 'bookmarks')

        if (isTopSite) {
            button.textContent = tradThis('Most visited')
            button.classList.add('topsites-title')
        }

        if (isDefault) {
            button.textContent = tradThis('Default folder')
        }

        button.addEventListener('click', changeFolder)

        document.querySelector('#link-mini div')?.appendChild(button)
    }

    domlinkblocks?.classList.toggle('with-groups', data.links.foldersOn && data.links.folders.length > 0)

    if (!data.links.foldersOn || data.links.folders.length === 0) {
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
    transition.transition(100)

    async function recreateLinksFromNewFolder(): Promise<void> {
        const buttons = document.querySelectorAll<HTMLElement>('#link-mini button')
        const data = await refreshBookmarksBeforeFolderRender(await storage.sync.get())
        const folderId = button.dataset.group ?? data.links.folders[0]?.id ?? 'default'

        for (const div of buttons ?? []) {
            div.classList.remove('selected-group')
        }
        button.classList.add('selected-group')
        data.links.selectedFolder = folderId
        await storage.sync.set({ links: data.links })
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

async function refreshBookmarksBeforeFolderRender(data: Sync): Promise<Sync> {
    try {
        const { bootstrapBookmarksFromConfig } = await import('./bookmarks.ts')
        return await bootstrapBookmarksFromConfig(data)
    } catch (_) {
        return data
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
        initFolders(data)
        return data
    }

    const folder = data.links.folders.find((item) => item.id === title.old || item.title === title.old)

    if (!folder) {
        return data
    }

    folder.title = title.new
    data.links.selectedFolder = folder.id
    initFolders(data)
    return data
}
export function deleteFolder(folderId: string, data: Sync): Sync {
    const { folders } = data.links
    const index = folders.findIndex((folder) => folder.id === folderId || folder.title === folderId)

    if (folders.length <= 1 || index < 0) {
        return data
    }

    const [removed] = folders.splice(index, 1)

    if (data.links.selectedFolder === removed.id) {
        data.links.selectedFolder = folders[0]?.id ?? 'default'
    }

    initblocks(data)
    initFolders(data)
    return data
}

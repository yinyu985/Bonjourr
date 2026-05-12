import {
    addFolder,
    changeFolderTitle,
    deleteFolder,
    initFolders,
    moveFolders,
    toggleFolders,
    updateSelectedFolderPosition,
} from './groups.ts'
import { initBookmarkSync, syncBookmarksUpdate } from './bookmarks.ts'
import { openContextMenu } from '../contextmenu.ts'
import { storeIconFile } from './fileicons.ts'
import { folderClick } from './folders.ts'
import { startDrag } from './drag.ts'
import {
    createTitle,
    getDefaultIcon,
    getLiFromEvent,
    getLinksInFolder,
    getLinksInSubfolder,
    isElem,
    isSubfolder,
} from './helpers.ts'
import { createLink, createSubfolder, FAVORITES_FOLDER, getFolder, getNode, newFolderId, removeNode } from './model.ts'

import { stringMaxSize } from '../../shared/generic.ts'
import { displayInterface } from '../../shared/display.ts'
import { getHTMLTemplate } from '../../shared/dom.ts'
import { eventDebounce } from '../../utils/debounce.ts'
import { storage } from '../../storage.ts'

import type { LinkElem, LinkIcon, LinkNode, LinkSubfolder } from '../../../types/shared.ts'
import type { Local } from '../../../types/local.ts'
import type { LinkFolder, Sync } from '../../../types/sync.ts'

type AddLinks = {
    title: string
    url: string
    folder?: string
    group?: string
    bookmarkId?: string
}[]

type UpdateLink = {
    id: string
    url?: string
    title: string
    icon?: LinkIcon
    file?: File
}

type AddFolders = {
    title: string
    sync?: boolean
}[]

type SubfolderMove = {
    source: string
    target: string
}

type MoveToFolderArgs = {
    source?: string
    target: string
    ids: string[]
}

type SubmitLink = {
    type: 'link'
    links: AddLinks
}

type SubmitSubfolder = {
    type: 'subfolder'
    ids: string[]
    title?: string
    folder?: string
}

export type LinksUpdate = {
    iconradius?: string
    row?: string
    newtab?: boolean
    folders?: boolean
    addLinks?: AddLinks
    addFolders?: AddFolders
    addSubfolder?: { ids: string[]; folder?: string; group?: string }
    updateLink?: UpdateLink
    moveLinks?: string[]
    moveFavorites?: string[]
    moveFolders?: string[]
    concatSubfolders?: SubfolderMove
    moveToSubfolder?: SubfolderMove
    moveToFolder?: SubfolderMove | MoveToFolderArgs
    moveOutSubfolder?: { ids: string[]; folder: string; group?: string }
    deleteFolder?: string
    deleteLinks?: string[]
    refreshIcons?: string[]
    folderTitle?: { old: string; new: string }
    styles?: { style?: string; titles?: boolean; backgrounds?: boolean }
    unsyncFolder?: string
}

type RenderFolder = {
    folder: LinkFolder
    items: LinkNode[]
    pinned: boolean
    synced: boolean
    div: HTMLDivElement | null
    lis: HTMLLIElement[]
}

type LinksInit = {
    sync: Sync
    local: Local
}

const domlinkblocks = document.getElementById('linkblocks') as HTMLDivElement
const domlinkmini = document.getElementById('link-mini') as HTMLDivElement
export const FAVORITES_GROUP = FAVORITES_FOLDER
let initIconList: [HTMLImageElement, string][] = []
let selectallTimer = 0

domlinkblocks.addEventListener('click', async (event: MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest('a')
    if (anchor && anchor.href.startsWith('data:')) {
        event.preventDefault()
        try {
            const response = await fetch(anchor.href)
            const blob = await response.blob()
            const blobUrl = URL.createObjectURL(blob)
            globalThis.open(blobUrl, '_blank')
        } catch {
            globalThis.open(anchor.href, '_blank')
        }
    }
})

export async function quickLinks(init?: LinksInit, event?: LinksUpdate): Promise<void> {
    if (event) {
        await linksUpdate(event)
        return
    }

    if (!init) {
        return
    }

    const { local } = init
    let { sync } = init

    domlinkblocks.classList.add(sync.links.style ?? 'inline')
    domlinkblocks.classList.toggle('titles', sync.links.titles)
    domlinkblocks.classList.toggle('backgrounds', sync.links.backgrounds)
    domlinkblocks.classList.toggle('hidden', !sync.links.enabled)

    sync = await initBookmarkSync(sync)

    initFolders(sync, !!init)
    initRows(sync.links.rows, sync.links.style)
    initblocks(sync, local)
}

export function initblocks(sync: Sync, local?: Local): true {
    initIconList = []
    const activeFolders: RenderFolder[] = getVisibleRenderFolders(sync)

    for (const folder of activeFolders) {
        const div = document.querySelector<HTMLDivElement>(`.link-group[data-group="${folder.folder.id}"]`)
        const subfolderId = div?.dataset.folder
        const items = subfolderId ? getLinksInSubfolder(sync, subfolderId) : folder.folder.items

        folder.div = div
        folder.items = items
    }

    const divs = activeFolders.map((folder) => folder.div)

    for (const div of document.querySelectorAll<HTMLDivElement>('#linkblocks .link-group')) {
        if (!divs.includes(div)) {
            div.remove()
        }
    }

    for (const activeFolder of activeFolders) {
        const linkgroup = activeFolder.div ?? getHTMLTemplate<HTMLDivElement>('link-group-template', '.link-group')
        const linklist = linkgroup.querySelector<HTMLUListElement>('ul')
        const linktitle = linkgroup.querySelector<HTMLButtonElement>('button')
        const fragment = document.createDocumentFragment()
        const subfolderId = linkgroup.dataset.folder

        if (!(linklist && linktitle)) {
            throw new Error('Template not found')
        }

        const existingItems = [...linklist.querySelectorAll<HTMLLIElement>('li')]

        for (const item of activeFolder.items) {
            let li = existingItems.find((existing) => existing.id === item.id)

            if (li) {
                li.removeAttribute('style')
                fragment.appendChild(li)
                continue
            }

            li = isElem(item) ? createElem(item, sync.links.newTab) : createSubfolderElement(item)

            fragment.appendChild(li)

            if (!activeFolder.synced) {
                li.addEventListener('keyup', openContextMenu)
                li.addEventListener('pointerdown', startDrag)
                li.addEventListener('click', selectAll)
                li.addEventListener('pointerdown', selectAll)
            }
        }

        linklist.innerHTML = ''
        linklist.appendChild(fragment)

        const subfolder = subfolderId ? getNode(sync, subfolderId) : undefined
        linktitle.textContent = isSubfolder(subfolder) ? subfolder.title : activeFolder.folder.title
        linkgroup.dataset.group = activeFolder.folder.id
        linkgroup.classList.toggle('pinned', activeFolder.pinned)
        linkgroup.classList.toggle('synced', activeFolder.synced)
        domlinkblocks.insertBefore(linkgroup, domlinkmini)
    }

    if (local) {
        createIcons(local)
    } else {
        storage.local.get().then((nextLocal) => createIcons(nextLocal))
    }

    initFavorites(sync)
    setRadius(sync.links.iconRadius)
    updateSelectedFolderPosition()
    displayInterface('links')

    return true
}

function getVisibleRenderFolders(sync: Sync): RenderFolder[] {
    const selected = getFolder(sync, sync.links.selectedFolder) ?? sync.links.folders[0]
    const visible = [selected, ...sync.links.folders.filter((folder) => folder.pinned)]
        .filter((folder): folder is LinkFolder => !!folder)
    const unique = new Map(visible.map((folder) => [folder.id, folder]))

    return [...unique.values()].map((folder) => ({
        folder,
        items: folder.items,
        pinned: folder.id !== sync.links.selectedFolder,
        synced: folder.source.type === 'bookmarks',
        div: null,
        lis: [],
    }))
}

export function initFavorites(sync: Sync): void {
    const container = document.getElementById('link-favorites')

    if (!container) {
        return
    }

    container.innerHTML = ''

    for (const link of sync.links.favorites) {
        const li = getHTMLTemplate<HTMLLIElement>('link-elem-template', 'li')
        const span = li.querySelector('span')
        const anchor = li.querySelector('a')

        if (!(li && span && anchor)) {
            continue
        }

        li.id = link.id
        li.classList.add('link-favorite')
        anchor.href = link.url
        span.textContent = createTitle(link)

        if (sync.links.newTab || anchor.href.startsWith('data:')) {
            anchor.target = '_blank'
        }

        container.appendChild(li)
    }

    container.classList.toggle('has-links', sync.links.favorites.length > 0)
}

export function createSubfolderElement(link: LinkSubfolder): HTMLLIElement {
    const li = getHTMLTemplate<HTMLLIElement>('link-folder-template', 'li')
    const imgs = li.querySelectorAll('img')
    const span = li.querySelector('span')

    if (!(li && imgs && span)) {
        throw new Error('Template not found')
    }

    li.id = link.id
    span.textContent = createTitle(link)
    li.addEventListener('mouseup', folderClick)
    li.addEventListener('keydown', folderClick)

    for (let index = 0; index < link.items.length; index++) {
        const img = imgs[index]
        const elem = link.items[index]

        if (img && elem) {
            initIconList.push([img, getIconFromLinkElem(elem)])
        }
    }

    return li
}

function createElem(link: LinkElem, openInNewtab: boolean): HTMLLIElement {
    const li = getHTMLTemplate<HTMLLIElement>('link-elem-template', 'li')
    const span = li.querySelector('span')
    const anchor = li.querySelector('a')
    const img = li.querySelector('img')

    if (!(li && span && anchor && img)) {
        throw new Error('Template not found')
    }

    li.id = link.id
    anchor.href = link.url
    span.textContent = createTitle(link)
    initIconList.push([img, getIconFromLinkElem(link)])

    if (openInNewtab || link.url.startsWith('data:')) {
        anchor.target = '_blank'
    }

    return li
}

function createIcons(local: Local): void {
    for (const [img, url] of initIconList) {
        img.src = url.startsWith('links') ? local[`x-icon-${url}`] ?? '' : url
    }

    setTimeout(() => {
        const incomplete = initIconList.filter(([img]) => !img.complete || img.naturalWidth === 0)

        for (const [img, url] of incomplete) {
            img.src = 'src/assets/interface/loading.svg'
            const newimg = document.createElement('img')
            newimg.addEventListener('load', () => {
                img.src = url
            })
            newimg.addEventListener('error', () => {
                img.src = 'https://services.bonjourr.fr/favicon/blob/error'
            })
            newimg.src = url
            setTimeout(() => {
                if (!newimg.complete && newimg.naturalWidth === 0) {
                    img.src = 'https://services.bonjourr.fr/favicon/blob/error'
                }
            }, 5000)
        }

        initIconList = []
    }, 400)
}

function initRows(row: number, style: string): void {
    const sizes = {
        inline: { width: 11, gap: 2 },
        text: { width: 5, gap: 2 },
    }

    if (style in sizes) {
        const { width, gap } = sizes[style as keyof typeof sizes]
        document.documentElement.style.setProperty('--links-width', `${Math.ceil((width + gap) * row)}rem`)
    }
}

queueMicrotask(() => {
    document.addEventListener('stop-select-all', () => clearTimeout(selectallTimer))
    document.addEventListener('remove-select-all', removeSelectAll)
})

function selectAll(event: MouseEvent): void {
    clearTimeout(selectallTimer)

    const selectAllActive = domlinkblocks.className.includes('select-all')
    const primaryButton = !event.button || event.button === 0
    const pointerUpOrClick = event.type.includes('pointerup') || event.type.includes('click')
    const li = getLiFromEvent(event)

    if (selectAllActive && pointerUpOrClick) {
        if (primaryButton) {
            li?.classList.toggle('selected')
        }
        event.preventDefault()
        return
    }

    if (!selectAllActive && primaryButton && event.type === 'pointerdown') {
        if ((event as PointerEvent)?.pointerType === 'touch') {
            return
        }

        selectallTimer = setTimeout(() => domlinkblocks.classList.add('select-all'), 600)
    }
}

function removeSelectAll(): void {
    clearTimeout(selectallTimer)
    domlinkblocks.classList.remove('select-all')
    for (const li of domlinkblocks.querySelectorAll('.link')) {
        li.classList.remove('selected')
    }
}

export async function linksUpdate(update: LinksUpdate): Promise<void> {
    let data = await storage.sync.get()

    if (await syncBookmarksUpdate(update, data)) {
        return
    }

    if (update.addLinks) data = linkSubmission({ type: 'link', links: update.addLinks }, data)
    if (update.addSubfolder) {
        data = linkSubmission({
            type: 'subfolder',
            ids: update.addSubfolder.ids,
            folder: update.addSubfolder.folder ?? update.addSubfolder.group,
        }, data)
    }
    if (update.addFolders) data = addFolder(update.addFolders, data)
    if (update.moveLinks) data = moveLinks(update.moveLinks, data)
    if (update.moveFavorites) data = moveFavorites(update.moveFavorites, data)
    if (update.moveFolders) data = moveFolders(update.moveFolders, data)
    if (update.moveToFolder && 'ids' in update.moveToFolder) data = moveToFolder(update.moveToFolder, data)
    if (update.moveToSubfolder || update.moveToFolder && 'source' in update.moveToFolder) {
        data = moveToSubfolder((update.moveToSubfolder ?? update.moveToFolder) as SubfolderMove, data)
    }
    if (update.concatSubfolders) data = concatSubfolders(update.concatSubfolders, data)
    if (update.moveOutSubfolder) {
        data = moveOutSubfolder({
            ids: update.moveOutSubfolder.ids,
            folder: update.moveOutSubfolder.folder,
        }, data)
    }
    if (update.updateLink) data = updateLink(update.updateLink, data)
    if (update.deleteLinks) data = deleteLinks(update.deleteLinks, data)
    if (update.folderTitle) data = changeFolderTitle(update.folderTitle, data)
    if (update.deleteFolder !== undefined) data = deleteFolder(update.deleteFolder, data)
    if (update.unsyncFolder !== undefined) data = unsyncFolder(update.unsyncFolder, data)
    if (update.folders !== undefined) data = toggleFolders(update.folders, data)
    if (update.newtab !== undefined) data = setOpenInNewTab(update.newtab, data)
    if (update.refreshIcons) data = refreshIcons(update.refreshIcons, data)
    if (update.styles) setLinkStyle(update.styles)
    if (update.row) setRows(update.row)
    if (update.iconradius) {
        eventDebounce({ links: { ...data.links, iconRadius: Number(update.iconradius) } })
        setRadius(update.iconradius)
        data.links.iconRadius = Number(update.iconradius)
    }

    if (update.styles || update.row) {
        return
    }

    await storage.sync.set(data)
}

function linkSubmission(args: SubmitLink | SubmitSubfolder, data: Sync): Sync {
    if (args.type === 'link') {
        for (const link of args.links) {
            const folderId = link.folder ?? link.group ?? data.links.selectedFolder
            const targetFolder = getFolder(data, folderId) ?? getFolderByTitleOrDefault(data, folderId)
            const created = validateLink(link.title, link.url, link.bookmarkId)

            if (link.bookmarkId) {
                created.bookmarkId = link.bookmarkId
            }

            targetFolder.items.push(created)
        }
    }

    if (args.type === 'subfolder') {
        const targetFolder = getFolderByTitleOrDefault(data, args.folder ?? data.links.selectedFolder)
        const selectedLinks = args.ids.map((id) => removeNode(data, id)).filter(isElem)
        const subfolder = createSubfolder(getSubfolderTitle(args.title), selectedLinks)
        targetFolder.items.push(subfolder)
    }

    storage.local.get().then((local) => initblocks(data, local))
    return data
}

function getSubfolderTitle(title?: string): string {
    const titledom = document.getElementById('e-title') as HTMLInputElement | null
    const linktitle = title ?? titledom?.value ?? ''

    if (titledom) {
        titledom.value = ''
    }

    return linktitle
}

function updateLink({ id, title, icon, url, file }: UpdateLink, data: Sync): Sync {
    const titledom = document.querySelector<HTMLSpanElement>(`#${id} span`)
    const icondom = document.querySelector<HTMLImageElement>(`#${id} img`)
    const urldom = document.querySelector<HTMLAnchorElement>(`#${id} a`)
    const node = getNode(data, id)

    if (!node) {
        return data
    }

    if (title !== undefined) {
        node.title = stringMaxSize(title, 64)
        if (titledom) titledom.textContent = node.title
    }

    if (isElem(node)) {
        if (icondom && icon) {
            updateIcon(id, node, icon, file, icondom)
        }

        if (titledom && urldom && url !== undefined) {
            node.url = normalizeLinkUrl(url)
            urldom.href = node.url
            titledom.textContent = createTitle(node)
        }
    }

    return data
}

function updateIcon(
    id: string,
    link: LinkElem,
    icon: LinkIcon,
    file: File | undefined,
    icondom: HTMLImageElement,
): void {
    const img = document.createElement('img')
    const currentSrc = icondom.src
    let url = getDefaultIcon(link.url)

    icondom.src = 'src/assets/interface/loading.svg'
    img.onload = () => {
        icondom.src = img.src
    }

    if (icon.type === 'auto') {
        icon.value = undefined
        img.src = url
    }

    if (icon.type === 'url') {
        if (icon.value && stringMaxSize(icon.value, 7500)) {
            url = icon.value
            img.src = url
        }
    }

    if (icon.type === 'file') {
        const currentIcon = link.icon
        if (!file && currentIcon?.type === 'file' && currentIcon.value) {
            icon = currentIcon
            img.src = currentSrc
        }
        if (file) {
            storeIconFile(id, file).then((uri) => {
                img.src = uri
            })
        }
    }

    link.icon = icon
}

function concatSubfolders({ target, source }: SubfolderMove, data: Sync): Sync {
    const targetNode = getNode(data, target)
    const sourceNode = getNode(data, source)

    if (!(isSubfolder(targetNode) && isSubfolder(sourceNode))) {
        return data
    }

    targetNode.items.push(...sourceNode.items)
    removeNode(data, source)
    initblocks(data)
    return data
}

function moveToSubfolder({ target, source }: SubfolderMove, data: Sync): Sync {
    const sourceNode = removeNode(data, source)
    const targetNode = getNode(data, target)

    if (isElem(sourceNode) && isSubfolder(targetNode)) {
        targetNode.items.push(sourceNode)
        initblocks(data)
    }

    return data
}

function moveOutSubfolder({ ids, folder }: { ids: string[]; folder: string }, data: Sync): Sync {
    const targetFolder = getFolderByTitleOrDefault(data, folder)

    for (const id of ids) {
        const node = removeNode(data, id)
        if (node) targetFolder.items.push(node)
    }

    initblocks(data)
    return data
}

function deleteLinks(ids: string[], data: Sync): Sync {
    for (const id of ids) {
        const node = getNode(data, id)

        if (isElem(node) && node.icon?.type === 'file') {
            storage.local.remove(`x-icon-${id}`)
        }

        if (isSubfolder(node)) {
            for (const child of node.items) {
                if (child.icon?.type === 'file') storage.local.remove(`x-icon-${child.id}`)
            }
        }

        removeNode(data, id)
    }

    storage.sync.clear()
    animateLinksRemove(ids)
    return data
}

function moveLinks(ids: string[], data: Sync): Sync {
    const folderId = document.querySelector<HTMLElement>('#linkblocks .link-group:not(.pinned)')?.dataset.group ??
        data.links.selectedFolder
    const subfolderId = domlinkblocks.dataset.folderid
    const items = subfolderId ? getLinksInSubfolder(data, subfolderId) : getFolder(data, folderId)?.items

    reorderItems(items, ids)
    initblocks(data)
    return data
}

function moveFavorites(ids: string[], data: Sync): Sync {
    const idSet = new Set(ids)
    const existingIds = new Set(data.links.favorites.map((link) => link.id))

    if (ids.every((id) => existingIds.has(id))) {
        reorderItems(data.links.favorites, ids)
    } else {
        for (const id of ids) {
            if (existingIds.has(id)) continue
            const node = removeNode(data, id)
            if (isElem(node)) data.links.favorites.push(node)
        }
    }

    data.links.favorites = data.links.favorites.filter((link) => idSet.has(link.id) || !ids.includes(link.id))
    initblocks(data)
    return data
}

function moveToFolder({ ids, target, source }: MoveToFolderArgs, data: Sync): Sync {
    const targetFolder = getFolderByTitleOrDefault(data, target)
    const moving = ids.map((id) => removeNode(data, id)).filter((node): node is LinkNode => !!node)
    const insertAt = source !== undefined ? Number.parseInt(source) : -1

    if (insertAt >= 0 && insertAt <= targetFolder.items.length) {
        targetFolder.items.splice(insertAt, 0, ...moving)
    } else {
        targetFolder.items.push(...moving)
    }

    data.links.selectedFolder = targetFolder.id
    initFolders(data)
    initblocks(data)
    return data
}

function refreshIcons(ids: string[], data: Sync): Sync {
    for (const id of ids) {
        const node = getNode(data, id)

        if (isElem(node)) {
            const unixDate = Date.now().toString()

            if (!node.icon || node.icon.type === 'auto') {
                node.icon = node.icon ?? { type: 'auto', value: '' }
                node.icon.value = getDefaultIcon(node.url) + `?r=${unixDate}`
            } else if (node.icon.type === 'url') {
                node.icon.value = `${node.icon.value}?r=${unixDate}`
            }
        }
    }

    initblocks(data)
    return data
}

function unsyncFolder(folderId: string, data: Sync): Sync {
    const folder = getFolder(data, folderId) ?? data.links.folders.find((item) => item.title === folderId)

    if (!folder || folder.source.type !== 'bookmarks') {
        return data
    }

    folder.source = { type: 'local' }
    const folderDiv = document.querySelector<HTMLDivElement>(`.link-group[data-group="${folder.id}"]`)
    folderDiv?.classList.remove('synced')

    return data
}

function setOpenInNewTab(newtab: boolean, data: Sync): Sync {
    const anchors = document.querySelectorAll<HTMLAnchorElement>('.link a')

    for (const anchor of anchors) {
        if (newtab || anchor.href.startsWith('data:')) {
            anchor.setAttribute('target', '_blank')
        } else {
            anchor.removeAttribute('target')
        }
    }

    data.links.newTab = newtab
    return data
}

async function setLinkStyle(styles: { style?: string; titles?: boolean; backgrounds?: boolean }): Promise<void> {
    const data = await storage.sync.get()
    const style = styles.style ?? 'inline'

    if (styles.style && isLinkStyle(style)) {
        domlinkblocks.classList.remove('inline', 'text')
        domlinkblocks.classList.add(style)
        data.links.style = style
        storage.sync.set({ links: data.links })
        initRows(data.links.rows, style)
    }

    if (typeof styles.titles === 'boolean') {
        data.links.titles = styles.titles
        storage.sync.set({ links: data.links })
        domlinkblocks.classList.toggle('titles', styles.titles)
    }

    if (typeof styles.backgrounds === 'boolean') {
        data.links.backgrounds = styles.backgrounds
        storage.sync.set({ links: data.links })
        domlinkblocks.classList.toggle('backgrounds', styles.backgrounds)
    }
}

function setRadius(radius: string | number): void {
    document.documentElement.style.setProperty('--link-outer-radius', `${radius}em`)
}

function setRows(row: string): void {
    const style = [...domlinkblocks.classList].filter(isLinkStyle)[0] ?? 'inline'
    const val = Number.parseInt(row ?? '6')
    initRows(val, style)
    storage.sync.get().then((data) => {
        data.links.rows = val
        eventDebounce({ links: data.links })
    })
}

export function validateLink(title: string, url: string, bookmarkId?: string): LinkElem {
    return createLink(title, normalizeLinkUrl(url), bookmarkId)
}

function normalizeLinkUrl(url: string): string {
    const startsWithEither = (values: string[]) => values.some((value) => url.startsWith(value))
    const isConfig = startsWithEither(['about:', 'chrome://', 'edge://'])
    const hasOwnProtocol = startsWithEither(['https://', 'http://', 'data:', 'ftp:'])
    const isLocalhost = url.startsWith('localhost') || url.startsWith('127.0.0.1')
    const prefix = isConfig ? '#' : isLocalhost ? 'http://' : !hasOwnProtocol ? 'https://' : ''

    return prefix + url
}

function animateLinksRemove(ids: string[]): void {
    for (const id of ids) {
        document.getElementById(id)?.classList.add('removed')
        setTimeout(() => document.getElementById(id)?.remove(), 600)
    }
}

function getIconFromLinkElem(link: LinkElem): string {
    if (!link.icon?.value) {
        try {
            const url = new URL(link.url)
            if (url.protocol === 'data:') {
                return link.id
            }
            return getDefaultIcon(url.origin + url.pathname)
        } catch (_) {
            return getDefaultIcon(link.url)
        }
    }

    if (link.icon.type === 'file') {
        return link.id
    }

    return link.icon.value
}

function isLinkStyle(style: string): style is Sync['links']['style'] {
    return ['inline', 'text'].includes(style)
}

function getFolderByTitleOrDefault(data: Sync, idOrTitle?: string): LinkFolder {
    const folder = getFolder(data, idOrTitle) ?? data.links.folders.find((item) => item.title === idOrTitle)

    if (folder) {
        return folder
    }

    const created: LinkFolder = {
        id: idOrTitle && idOrTitle !== '+' ? idOrTitle : newFolderId(),
        title: idOrTitle && idOrTitle !== '+' ? idOrTitle : 'default',
        pinned: false,
        source: { type: 'local' },
        items: [],
    }
    data.links.folders.push(created)
    return created
}

function reorderItems<T extends { id: string }>(items: T[] | undefined, ids: string[]): void {
    if (!items) {
        return
    }

    const itemById = new Map(items.map((item) => [item.id, item]))
    const ordered = ids.map((id) => itemById.get(id)).filter((item): item is T => !!item)
    const missing = items.filter((item) => !ids.includes(item.id))

    items.splice(0, items.length, ...ordered, ...missing)
}

export const getLinksInGroup = getLinksInFolder

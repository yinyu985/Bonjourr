import { changeFolderTitle, deleteFolder, initFolders, toggleFolders, updateSelectedFolderPosition } from './groups.ts'
import { initBookmarkSync, syncBookmarksUpdate } from './bookmarks.ts'
import { openContextMenu } from '../contextmenu.ts'
import { storeIconFile } from './fileicons.ts'
import { collapseAllPanels, folderClick } from './folders.ts'
import {
    createTitle,
    DEFAULT_FAVICON,
    FOLDER_ICON,
    getDefaultIcon,
    getLiFromEvent,
    getLinksInSubfolder,
    isElem,
    isSubfolder,
} from './helpers.ts'
import { createLink, createSubfolder, FAVORITES_FOLDER, getFolder, getNode, newFolderId, removeNode } from './model.ts'

import { EXTENSION, PLATFORM } from '../../defaults.ts'
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
    id?: string
}[]

type UpdateLink = {
    id: string
    url?: string
    title: string
    icon?: LinkIcon
    file?: File
}

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
    addSubfolder?: { ids: string[]; folder?: string; group?: string }
    updateLink?: UpdateLink
    moveLinks?: string[]
    moveFavorites?: string[]
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

const INTERNAL_URL_SCHEMES = [
    'about:',
    'chrome://',
    'edge://',
    'helium://',
    'brave://',
    'opera://',
    'vivaldi://',
    'arc://',
]

domlinkblocks.addEventListener('click', (event: MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest('a')
    if (!anchor) {
        return
    }

    // Chrome 阻止顶层导航到 data:，但扩展上下文可以通过 tabs.create 直达，
    // 地址栏保留原始 data: URL，无需 blob 兜底（也就没有 createObjectURL 泄漏）。
    if (anchor.href.startsWith('data:')) {
        const tabs = EXTENSION?.tabs as typeof chrome.tabs | undefined
        if (tabs) {
            event.preventDefault()
            tabs.create({ url: anchor.href })
        }
        return
    }

    const internalUrl = extractInternalUrl(anchor.getAttribute('href') ?? '')
    if (internalUrl) {
        event.preventDefault()
        openInternalUrl(internalUrl, anchor.target === '_blank')
    }
})

function extractInternalUrl(href: string): string | null {
    const candidate = href.startsWith('#') ? href.slice(1) : href
    return INTERNAL_URL_SCHEMES.some((scheme) => candidate.startsWith(scheme)) ? candidate : null
}

function openInternalUrl(url: string, newTab: boolean): void {
    const tabs = EXTENSION?.tabs as typeof chrome.tabs | undefined
    if (!tabs) {
        return
    }
    if (newTab) {
        tabs.create({ url })
    } else {
        tabs.update({ url })
    }
}

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
    // Re-render destroys/reorders the <li> nodes the open panels point to.
    // Drop any open subfolder popovers before rebuilding so we don't keep
    // stale openers in the panel stack.
    collapseAllPanels()

    initIconList = []
    const activeFolders: RenderFolder[] = getVisibleRenderFolders(sync)

    for (const folder of activeFolders) {
        const div = document.querySelector<HTMLDivElement>(`.link-group[data-group="${folder.folder.id}"]`)
        folder.div = div
        folder.items = folder.folder.items
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

        if (!(linklist && linktitle)) {
            throw new Error('Template not found')
        }

        const existingItems = [...linklist.querySelectorAll<HTMLLIElement>('li')]

        const sortedItems = [...activeFolder.items].sort((a, b) => {
            return (isSubfolder(a) ? 1 : 0) - (isSubfolder(b) ? 1 : 0)
        })

        for (const item of sortedItems) {
            let li = existingItems.find((existing) => existing.id === item.id)

            if (li) {
                li.removeAttribute('style')
                fragment.appendChild(li)
                continue
            }

            li = isElem(item) ? createElem(item, sync.links.newTab) : createSubfolderElement(item)

            fragment.appendChild(li)

            li.addEventListener('keyup', openContextMenu)
            li.addEventListener('click', selectAll)
            li.addEventListener('pointerdown', selectAll)
        }

        linklist.innerHTML = ''
        linklist.appendChild(fragment)

        linktitle.textContent = activeFolder.folder.title
        linkgroup.dataset.group = activeFolder.folder.id
        linkgroup.classList.remove('synced')
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
    const folder = getFolder(sync, sync.links.selectedFolder) ?? sync.links.folders[0]

    if (!folder) {
        return []
    }

    return [{
        folder,
        items: folder.items,
        div: null,
        lis: [],
    }]
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
    const span = li.querySelector('span')
    const img = li.querySelector('img')

    if (!(span && img)) {
        throw new Error('Template not found')
    }

    li.id = link.id
    span.textContent = createTitle(link)
    // Static folder glyph — same gray tone as DEFAULT_FAVICON so subfolder
    // rows align horizontally with link rows in the same list and look like
    // the same family of icon.
    img.src = FOLDER_ICON
    li.addEventListener('mouseup', folderClick)
    li.addEventListener('keydown', folderClick)

    return li
}

export function createElem(link: LinkElem, openInNewtab: boolean): HTMLLIElement {
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

// Per-host resolved icon: data URL or DEFAULT_FAVICON. Hydrated from
// storage.local.linkIconResolutions on page load — once a host has been
// resolved, all future renders (including across reloads) hit this map and
// skip every fetch / Chrome API call.
//
// Map 自带插入顺序 → 拿来当 LRU 用：命中即"删后重 set"把它移到末尾，写入时
// 超过 cap 就从头删。否则用户长期使用后此处会无界增长（每个值是 ~2KB base64
// favicon，1000 个 host 就 ~2MB 常驻），且 storage.local.set 序列化整张表
// 也越来越慢。
const ICON_CACHE_CAP = 500
const iconResolvedByHost = new Map<string, string>()

// In-flight resolution promises, keyed by host, to dedupe concurrent
// resolutions for the same host within a single render batch.
const iconInflightByHost = new Map<string, Promise<string>>()

let resolutionsHydrated = false

export function createIcons(local: Local): void {
    if (!resolutionsHydrated) {
        resolutionsHydrated = true
        const stored = local.linkIconResolutions ?? {}
        // 启动时只灌入末尾 cap 项；超出的当作"最久没访问到"丢弃。
        const entries = Object.entries(stored)
        for (const [host, value] of entries.slice(-ICON_CACHE_CAP)) {
            iconResolvedByHost.set(host, value)
        }
    }

    const resolved = initIconList.map(([img, url]) => [img, resolveIconUrl(local, url)] as [HTMLImageElement, string])
    initIconList = []

    for (const [img, url] of resolved) {
        loadIconWithFallback(img, url)
    }
}

function touchIconCache(host: string, value: string): void {
    // 删后再 set，让 host 落到 Map 末尾（最近使用）。
    iconResolvedByHost.delete(host)
    iconResolvedByHost.set(host, value)

    while (iconResolvedByHost.size > ICON_CACHE_CAP) {
        const oldest = iconResolvedByHost.keys().next().value
        if (oldest === undefined) break
        iconResolvedByHost.delete(oldest)
    }
}

function getCachedIcon(host: string): string | undefined {
    const value = iconResolvedByHost.get(host)
    if (value !== undefined) {
        // 命中也算一次访问，搬到末尾。
        iconResolvedByHost.delete(host)
        iconResolvedByHost.set(host, value)
    }
    return value
}

// 节流落盘：连续解析多个 favicon 时不要每个都序列化整张表落盘一次。
// 直接 dump 当前 Map，不再 spread 老 storage —— Map 已经是事实来源，
// 而且按 LRU 顺序输出能让下次启动也按相同顺序 hydrate。
let persistTimer = 0

function persistResolutions(): void {
    if (persistTimer) {
        return
    }
    persistTimer = setTimeout(() => {
        persistTimer = 0
        storage.local.set({ linkIconResolutions: Object.fromEntries(iconResolvedByHost) })
    }, 1000)
}

function hostFromDdgUrl(ddgUrl: string): string | undefined {
    try {
        const match = new URL(ddgUrl).pathname.match(/^\/ip3\/(.+)\.ico$/)
        return match?.[1]
    } catch (_) {
        return undefined
    }
}

function loadIconWithFallback(img: HTMLImageElement, primaryUrl: string): void {
    // Non-DDG URLs (user-set custom URL, data:, local-icon blob) have no
    // "404 with body" problem. Set src directly; on error fall back once.
    if (!isDuckDuckGoUrl(primaryUrl)) {
        img.addEventListener('error', () => {
            img.src = DEFAULT_FAVICON
        }, { once: true })
        img.src = primaryUrl
        return
    }

    const host = hostFromDdgUrl(primaryUrl)
    if (!host) {
        img.src = DEFAULT_FAVICON
        return
    }

    const cached = getCachedIcon(host)
    if (cached) {
        img.src = cached
        return
    }

    img.src = 'src/assets/interface/loading.svg'
    resolveHostIcon(host, primaryUrl).then((resolved) => {
        img.src = resolved
    })
}

function resolveHostIcon(host: string, ddgUrl: string): Promise<string> {
    const inflight = iconInflightByHost.get(host)
    if (inflight) {
        return inflight
    }

    const promise = resolveHostIconInner(host, ddgUrl).then((value) => {
        touchIconCache(host, value)
        persistResolutions()
        return value
    }).finally(() => {
        iconInflightByHost.delete(host)
    })

    iconInflightByHost.set(host, promise)
    return promise
}

async function resolveHostIconInner(_host: string, ddgUrl: string): Promise<string> {
    try {
        const resp = await fetch(ddgUrl)
        if (resp.ok) {
            const blob = await resp.blob()
            return await blobToDataUrl(blob)
        }
    } catch (_) {
        // Offline / network error — fall through to Chrome path.
    }

    return await resolveChromeFaviconAsDataUrl(ddgUrl)
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(reader.error ?? new Error('blob read failed'))
        reader.readAsDataURL(blob)
    })
}

async function resolveChromeFaviconAsDataUrl(ddgUrl: string): Promise<string> {
    if (PLATFORM !== 'chrome') {
        return DEFAULT_FAVICON
    }

    const original = originalUrlFromDuckDuckGo(ddgUrl)
    if (!original) {
        return DEFAULT_FAVICON
    }

    const chromeFaviconUrl = buildChromeFaviconUrl(original)

    // Load through a temporary <img>, then paint onto a canvas to extract
    // a data URL. This captures the pixels once and caches them — subsequent
    // uses never hit the Chrome _favicon API again.
    try {
        const dataUrl = await imageUrlToDataUrl(chromeFaviconUrl)
        return dataUrl
    } catch (_) {
        return DEFAULT_FAVICON
    }
}

function imageUrlToDataUrl(url: string, timeoutMs = 1500): Promise<string> {
    return new Promise((resolve, reject) => {
        const tmpImg = new Image()
        tmpImg.crossOrigin = 'anonymous'
        const timer = setTimeout(() => {
            tmpImg.src = ''
            reject(new Error('image load timeout'))
        }, timeoutMs)
        tmpImg.onload = () => {
            clearTimeout(timer)
            try {
                const canvas = document.createElement('canvas')
                canvas.width = tmpImg.naturalWidth || 32
                canvas.height = tmpImg.naturalHeight || 32
                const ctx = canvas.getContext('2d')
                if (!ctx) {
                    reject(new Error('no 2d context'))
                    return
                }
                ctx.drawImage(tmpImg, 0, 0)
                resolve(canvas.toDataURL('image/png'))
            } catch (error) {
                reject(error)
            }
        }
        tmpImg.onerror = () => {
            clearTimeout(timer)
            reject(new Error('image load failed'))
        }
        tmpImg.src = url
    })
}

function isDuckDuckGoUrl(url: string): boolean {
    return url.startsWith('https://icons.duckduckgo.com/ip3/')
}

function originalUrlFromDuckDuckGo(ddgUrl: string): string | undefined {
    try {
        const m = new URL(ddgUrl).pathname.match(/^\/ip3\/(.+)\.ico$/)
        return m ? `https://${m[1]}/` : undefined
    } catch (_) {
        return undefined
    }
}

function buildChromeFaviconUrl(pageUrl: string): string {
    const u = new URL(chrome.runtime.getURL('/_favicon/'))
    u.searchParams.set('pageUrl', pageUrl)
    u.searchParams.set('size', '32')
    return u.toString()
}

function resolveIconUrl(local: Local, url: string): string {
    if (url.startsWith('local-icon:')) {
        return local[`x-icon-${url.slice('local-icon:'.length)}`] ?? ''
    }

    return url
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
    if (update.moveLinks) data = moveLinks(update.moveLinks, data)
    if (update.moveFavorites) data = moveFavorites(update.moveFavorites, data)
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
            targetFolder.items.push(validateLink(link.title, link.url, link.id))
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
    const linkElement = document.getElementById(id)
    const titledom = linkElement?.querySelector<HTMLSpanElement>('span')
    const icondom = linkElement?.querySelector<HTMLImageElement>('img')
    const urldom = linkElement?.querySelector<HTMLAnchorElement>('a')
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
                if (isElem(child) && child.icon?.type === 'file') storage.local.remove(`x-icon-${child.id}`)
            }
        }

        removeNode(data, id)
    }

    animateLinksRemove(ids)
    return data
}

function moveLinks(ids: string[], data: Sync): Sync {
    const folderId = document.querySelector<HTMLElement>('#linkblocks .link-group')?.dataset.group ??
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
            const unixDate = Date.now()

            if (!node.icon || node.icon.type === 'auto') {
                node.icon = node.icon ?? { type: 'auto', value: '' }
                node.icon.value = getDefaultIcon(node.url, unixDate)
            } else if (node.icon.type === 'url') {
                node.icon.value = `${node.icon.value}?r=${unixDate}`
            }
        }
    }

    initblocks(data)
    return data
}

function unsyncFolder(_folderId: string, data: Sync): Sync {
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
    let dirty = false

    if (styles.style && isLinkStyle(style)) {
        domlinkblocks.classList.remove('inline', 'text')
        domlinkblocks.classList.add(style)
        data.links.style = style
        initRows(data.links.rows, style)
        dirty = true
    }

    if (typeof styles.titles === 'boolean') {
        data.links.titles = styles.titles
        domlinkblocks.classList.toggle('titles', styles.titles)
        dirty = true
    }

    if (typeof styles.backgrounds === 'boolean') {
        data.links.backgrounds = styles.backgrounds
        domlinkblocks.classList.toggle('backgrounds', styles.backgrounds)
        dirty = true
    }

    if (dirty) {
        await storage.sync.set({ links: data.links })
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

export function validateLink(title: string, url: string, id?: string): LinkElem {
    return createLink(title, normalizeLinkUrl(url), id)
}

function normalizeLinkUrl(url: string): string {
    const startsWithEither = (values: string[]) => values.some((value) => url.startsWith(value))
    const isConfig = startsWithEither(INTERNAL_URL_SCHEMES)
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
    const stored = link.icon?.value
    // Legacy chrome-extension://[id]/_favicon/ values were persisted by
    // refreshIcons in earlier versions. Treat them as missing so they get
    // recomputed via DDG → Chrome → DEFAULT_FAVICON on render.
    const isStaleChromeFavicon = typeof stored === 'string' &&
        stored.startsWith('chrome-extension://') &&
        stored.includes('/_favicon/')

    if (!stored || isStaleChromeFavicon) {
        try {
            const url = new URL(link.url)
            if (url.protocol === 'data:') {
                return `local-icon:${link.id}`
            }
            return getDefaultIcon(url.origin + url.pathname)
        } catch (_) {
            return getDefaultIcon(link.url)
        }
    }

    if (link.icon?.type === 'file') {
        return `local-icon:${link.id}`
    }

    return stored
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

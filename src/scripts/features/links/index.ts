import { initFolders, toggleFolders, updateSelectedFolderPosition } from './groups.ts'
import { initBookmarkSync } from './bookmarks.ts'
import { collapseAllPanels, folderClick } from './folders.ts'
import { createTitle, DEFAULT_FAVICON, FOLDER_ICON, getDefaultIcon, isElem, isSubfolder } from './helpers.ts'
import { createLink, FAVORITES_FOLDER, getFolder, linksWithBookmarks } from './model.ts'

import { EXTENSION, PLATFORM } from '../../defaults.ts'
import { displayInterface } from '../../shared/display.ts'
import { getHTMLTemplate } from '../../shared/dom.ts'
import { eventDebounce } from '../../utils/debounce.ts'
import { storage } from '../../storage.ts'

import type { LinkElem, LinkNode, LinkSubfolder } from '../../../types/shared.ts'
import type { Local } from '../../../types/local.ts'
import type { LinkFolder, Sync, SyncSnapshot } from '../../../types/sync.ts'

export type LinksUpdate = {
    iconradius?: string
    row?: string
    newtab?: boolean
    folders?: boolean
    styles?: { style?: string; titles?: boolean; backgrounds?: boolean }
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

    const { sync } = init

    domlinkblocks.classList.add(sync.links.style ?? 'inline')
    domlinkblocks.classList.toggle('titles', sync.links.titles)
    domlinkblocks.classList.toggle('backgrounds', sync.links.backgrounds)
    domlinkblocks.classList.toggle('hidden', !sync.links.enabled)

    const snapshot = await initBookmarkSync(sync)

    initFolders(snapshot, !!init)
    initRows(snapshot.links.rows, snapshot.links.style)
    initblocks(snapshot)
}

export function initblocks(sync: SyncSnapshot): true {
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
        }

        linklist.innerHTML = ''
        linklist.appendChild(fragment)

        linktitle.textContent = activeFolder.folder.title
        linkgroup.dataset.group = activeFolder.folder.id
        linkgroup.classList.remove('synced')
        domlinkblocks.insertBefore(linkgroup, domlinkmini)
    }

    createIcons()

    initFavorites(sync)
    setRadius(sync.links.iconRadius)
    updateSelectedFolderPosition()
    displayInterface('links')

    return true
}

function getVisibleRenderFolders(sync: Sync): RenderFolder[] {
    const links = linksWithBookmarks(sync)
    const folder = getFolder(sync, links.selectedFolder) ?? links.folders[0]

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

export function initFavorites(sync: SyncSnapshot): void {
    const container = document.getElementById('link-favorites')

    if (!container) {
        return
    }

    container.innerHTML = ''

    const links = linksWithBookmarks(sync)

    for (const link of links.favorites) {
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

    container.classList.toggle('has-links', links.favorites.length > 0)
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

// Per-host resolved icon: data URL or DEFAULT_FAVICON. This cache is runtime
// only; Quick Links never persist custom or refreshed icon data.
//
// Map 自带插入顺序 → 拿来当 LRU 用：命中即"删后重 set"把它移到末尾。
const ICON_CACHE_CAP = 500
const iconResolvedByHost = new Map<string, string>()

const iconInflightByHost = new Map<string, Promise<string>>()

export function createIcons(): void {
    const resolved = initIconList
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

function hostFromDdgUrl(ddgUrl: string): string | undefined {
    try {
        const match = new URL(ddgUrl).pathname.match(/^\/ip3\/(.+)\.ico$/)
        return match?.[1]
    } catch (_) {
        return undefined
    }
}

function loadIconWithFallback(img: HTMLImageElement, primaryUrl: string): void {
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

export async function linksUpdate(update: LinksUpdate): Promise<void> {
    let data = await storage.sync.get()

    if (update.folders !== undefined) data = toggleFolders(update.folders, data)
    if (update.newtab !== undefined) data = setOpenInNewTab(update.newtab, data)
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

function getIconFromLinkElem(link: LinkElem): string {
    try {
        const url = new URL(link.url)
        if (url.protocol === 'data:') {
            return DEFAULT_FAVICON
        }
        return getDefaultIcon(url.origin + url.pathname)
    } catch (_) {
        return getDefaultIcon(link.url)
    }
}

function isLinkStyle(style: string): style is Sync['links']['style'] {
    return ['inline', 'text'].includes(style)
}

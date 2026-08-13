import { initFolders, toggleFolders, updateSelectedFolderPosition } from './groups.ts'
import { initBookmarkSync } from './bookmarks.ts'
import { collapseAllPanels, folderClick } from './folders.ts'
import { createTitle, DEFAULT_FAVICON, FOLDER_ICON, getDefaultIcon, isElem, isSubfolder } from './helpers.ts'
import { createLink, FAVORITES_FOLDER, getFolder, linksWithBookmarks } from './model.ts'

import { EXTENSION } from '../../defaults.ts'
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
let latestSnapshot: SyncSnapshot | undefined
let linksVisibilityObserver: MutationObserver | undefined
let linksWereVisible = true

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
            void tabs.create({ url: anchor.href }).catch((err) => console.warn('Cannot open data bookmark', err))
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
        void tabs.create({ url }).catch((err) => console.warn('Cannot open internal bookmark', err))
    } else {
        void tabs.update({ url }).catch((err) => console.warn('Cannot navigate to internal bookmark', err))
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
    latestSnapshot = snapshot
    observeLinksVisibility()

    if (!snapshot.links.enabled) {
        displayInterface('links')
        return
    }

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
    latestSnapshot = sync

    if (!sync.links.enabled || domlinkblocks.classList.contains('hidden')) {
        displayInterface('links')
        return true
    }

    const activeFolders: RenderFolder[] = getVisibleRenderFolders(sync)

    for (const folder of activeFolders) {
        const div = [...document.querySelectorAll<HTMLDivElement>('.link-group')].find((candidate) =>
            candidate.dataset.group === folder.folder.id
        ) ?? null
        folder.div = div
        folder.items = folder.folder.items
    }

    const activeDivs = new Set(activeFolders.map((folder) => folder.div))

    for (const div of document.querySelectorAll<HTMLDivElement>('#linkblocks .link-group')) {
        if (!activeDivs.has(div)) {
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

        const existingItems = new Map(
            [...linklist.querySelectorAll<HTMLLIElement>('li')].map((li) => [li.id, li]),
        )

        const sortedItems = [...activeFolder.items].sort((a, b) => {
            return (isSubfolder(a) ? 1 : 0) - (isSubfolder(b) ? 1 : 0)
        })

        for (const item of sortedItems) {
            let li = existingItems.get(item.id)
            const expectedClass = isElem(item) ? 'link-elem' : 'link-folder'

            if (li?.classList.contains(expectedClass)) {
                existingItems.delete(item.id)
                li.removeAttribute('style')
                if (isElem(item)) {
                    updateElemElement(li, item, sync.links.newTab)
                } else {
                    updateSubfolderElement(li, item)
                }
                fragment.appendChild(li)
                continue
            }

            li = isElem(item) ? createElem(item, sync.links.newTab) : createSubfolderElement(item)

            fragment.appendChild(li)
        }

        linklist.replaceChildren(fragment)

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

function observeLinksVisibility(): void {
    if (linksVisibilityObserver) {
        return
    }

    linksWereVisible = !domlinkblocks.classList.contains('hidden')
    linksVisibilityObserver = new MutationObserver(() => {
        if (!latestSnapshot) {
            return
        }

        const enabled = !domlinkblocks.classList.contains('hidden')
        if (enabled === linksWereVisible) {
            return
        }

        linksWereVisible = enabled
        latestSnapshot.links.enabled = enabled

        if (enabled) {
            initFolders(latestSnapshot)
            initRows(latestSnapshot.links.rows, latestSnapshot.links.style)
            initblocks(latestSnapshot)
        }
    })
    linksVisibilityObserver.observe(domlinkblocks, { attributes: true, attributeFilter: ['class'] })
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
    li.id = link.id
    updateSubfolderElement(li, link)
    const openFolder = (event: MouseEvent | KeyboardEvent): void => {
        void folderClick(event).catch((err) => console.warn('Cannot open bookmark folder', err))
    }
    li.addEventListener('mouseup', openFolder)
    li.addEventListener('keydown', openFolder)

    return li
}

function updateSubfolderElement(li: HTMLLIElement, link: LinkSubfolder): void {
    const span = li.querySelector('span')
    const img = li.querySelector('img')

    if (!(span && img)) {
        throw new Error('Template not found')
    }

    span.textContent = createTitle(link)
    img.src = FOLDER_ICON
}

export function createElem(link: LinkElem, openInNewtab: boolean): HTMLLIElement {
    const li = getHTMLTemplate<HTMLLIElement>('link-elem-template', 'li')
    li.id = link.id
    updateElemElement(li, link, openInNewtab)
    return li
}

function updateElemElement(li: HTMLLIElement, link: LinkElem, openInNewtab: boolean): void {
    const span = li.querySelector('span')
    const anchor = li.querySelector('a')
    const img = li.querySelector('img')

    if (!(li && span && anchor && img)) {
        throw new Error('Template not found')
    }

    anchor.href = link.url
    span.textContent = createTitle(link)
    const icon = getIconFromLinkElem(link)
    if (img.dataset.faviconFor !== icon) {
        img.dataset.faviconFor = icon
        initIconList.push([img, icon])
    }

    if (openInNewtab || link.url.startsWith('data:')) {
        anchor.target = '_blank'
    } else {
        anchor.removeAttribute('target')
    }
}

export function createIcons(): void {
    const resolved = initIconList
    initIconList = []

    for (const [img, url] of resolved) {
        loadIconWithFallback(img, url)
    }
}

function loadIconWithFallback(img: HTMLImageElement, primaryUrl: string): void {
    img.addEventListener('error', () => {
        img.src = DEFAULT_FAVICON
    }, { once: true })
    img.src = primaryUrl
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
    const data = await storage.sync.get()

    if (update.folders !== undefined) toggleFolders(update.folders, data)
    if (update.newtab !== undefined) setOpenInNewTab(update.newtab, data)
    if (update.styles) setLinkStyle(update.styles)
    if (update.row) setRows(update.row)
    if (update.iconradius) {
        eventDebounce({ links: { iconRadius: Number(update.iconradius) } })
        setRadius(update.iconradius)
        data.links.iconRadius = Number(update.iconradius)
    }

    if (update.styles || update.row) {
        return
    }

    await storage.sync.update((current) => {
        if (update.folders !== undefined) current.links.foldersOn = update.folders
        if (update.newtab !== undefined) current.links.newTab = update.newtab
    })
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
        await storage.sync.update((current) => {
            current.links.style = data.links.style
            current.links.titles = data.links.titles
            current.links.backgrounds = data.links.backgrounds
        })
    }
}

function setRadius(radius: string | number): void {
    document.documentElement.style.setProperty('--link-outer-radius', `${radius}em`)
}

function setRows(row: string): void {
    const style = [...domlinkblocks.classList].filter(isLinkStyle)[0] ?? 'inline'
    const val = Number.parseInt(row ?? '6')
    initRows(val, style)
    void storage.sync.update((data) => {
        data.links.rows = val
    }).catch((err) => console.warn('Cannot save link row count', err))
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
        return getDefaultIcon(link.url)
    } catch (_) {
        return DEFAULT_FAVICON
    }
}

function isLinkStyle(style: string): style is Sync['links']['style'] {
    return ['inline', 'text'].includes(style)
}

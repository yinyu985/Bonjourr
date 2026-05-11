import {
    addGroup,
    changeGroupTitle,
    deleteGroup,
    initGroups,
    moveGroups,
    toggleGroups,
    updateSelectedGroupPosition,
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
    getLinksInGroup,
    isElem,
    isLink,
} from './helpers.ts'

import { randomString, stringMaxSize } from '../../shared/generic.ts'
import { displayInterface } from '../../shared/display.ts'
import { getHTMLTemplate } from '../../shared/dom.ts'
import { eventDebounce } from '../../utils/debounce.ts'
import { tradThis } from '../../utils/translations.ts'
import { storage } from '../../storage.ts'

import type { Link, LinkElem, LinkFolder, LinkIcon } from '../../../types/shared.ts'
import type { Local } from '../../../types/local.ts'
import type { Sync } from '../../../types/sync.ts'

type AddLinks = {
    title: string
    url: string
    group?: string
    bookmark?: LinkElem['bookmark']
}[]

type UpdateLink = {
    id: string
    url?: string
    title: string
    icon?: LinkIcon
    file?: File
}

type AddGroups = {
    title: string
    sync?: boolean
}[]

type MoveToFolder = {
    source: string
    target: string
}

type MoveToGroup = {
    source?: string
    target: string
    ids: string[]
}

type SubmitLink = {
    type: 'link'
    links: AddLinks
}

type SubmitFolder = {
    type: 'folder'
    ids: string[]
    title?: string
    group?: string
}

type LinksUpdate = {
    iconradius?: string
    row?: string
    newtab?: boolean
    groups?: boolean
    addLinks?: AddLinks
    addGroups?: AddGroups
    addFolder?: { ids: string[]; group?: string }
    updateLink?: UpdateLink
    moveLinks?: string[]
    moveFavorites?: string[]
    moveGroups?: string[]
    concatFolders?: MoveToFolder
    moveToFolder?: MoveToFolder
    moveToGroup?: MoveToGroup
    moveOutFolder?: { ids: string[]; group: string }
    deleteGroup?: string
    deleteLinks?: string[]
    refreshIcons?: string[]
    groupTitle?: { old: string; new: string }
    styles?: { style?: string; titles?: boolean; backgrounds?: boolean }
    unsyncGroup?: string
}

type LinkGroups = {
    links: Link[]
    title: string
    pinned: boolean
    synced: boolean
    lis: HTMLLIElement[]
    div: HTMLDivElement | null
}[]

type LinksInit = {
    sync: Sync
    local: Local
}

const domlinkblocks = document.getElementById('linkblocks') as HTMLDivElement
const domlinkmini = document.getElementById('link-mini') as HTMLDivElement
export const FAVORITES_GROUP = '__favorites'
let initIconList: [HTMLImageElement, string][] = []
let selectallTimer = 0

// Intercept clicks on data: URLs — Chrome blocks all navigation to data: URLs,
// so we convert to a blob URL first and open that in a new tab.
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

    // set class before appendBlock, cannot be moved
    domlinkblocks.classList.add(sync.linkstyle ?? 'inline')
    domlinkblocks.classList.toggle('titles', sync.linktitles)
    domlinkblocks.classList.toggle('backgrounds', sync.linkbackgrounds)
    domlinkblocks.classList.toggle('hidden', !sync.quicklinks)

    // Always run bookmark sync when the bookmarks API is available so the
    // favorites bar stays in sync with the toolbar, even when the user has no
    // named synced groups. initBookmarkSync is a no-op when the API is missing
    // and returns the up-to-date data so we render with the freshest state.
    sync = await initBookmarkSync(sync)

    initGroups(sync, !!init)
    initRows(sync.linksrow, sync.linkstyle)
    initblocks(sync, local)
}

// Initialisation

export function initblocks(sync: Sync, local?: Local): true {
    const allLinks = Object.values(sync).filter((val) => isLink(val)) as Link[]
    const { groups, pinned, synced, selected } = sync.linkgroups
    const activeGroups: LinkGroups = []
    const visibleGroups = uniqueStrings([selected, ...pinned]).filter((group) => groups.includes(group))

    for (const group of visibleGroups) {
        const div = document.querySelector<HTMLDivElement>(`.link-group[data-group="${group}"]`)
        const folder = div?.dataset.folder
        const lis: HTMLLIElement[] = []
        const links = folder ? getLinksInFolder(sync, folder) : getLinksInGroup(sync, group)

        activeGroups.push({
            lis,
            div,
            links,
            title: group,
            pinned: group !== selected,
            synced: synced?.includes(group),
        })
    }

    // Remove links that didn't make the cut
    const divs = activeGroups.map((g) => g.div)
    const usedLis = activeGroups.flatMap((group) => group.lis)

    for (const div of document.querySelectorAll<HTMLDivElement>('#linkblocks .link-group')) {
        for (const li of div.querySelectorAll<HTMLLIElement>('li')) {
            if (usedLis.includes(li) === false) {
                li.remove()
            }
        }

        if (divs.includes(div) === false) {
            div.remove()
        }
    }

    for (const group of activeGroups) {
        const linkgroup = group.div ?? getHTMLTemplate<HTMLDivElement>('link-group-template', '.link-group')
        const linksInFolders = allLinks.filter((link) => !link.folder && typeof link.parent === 'string')
        const linklist = linkgroup.querySelector<HTMLUListElement>('ul')
        const linktitle = linkgroup.querySelector<HTMLButtonElement>('button')
        const fragment = document.createDocumentFragment()
        const folderid = linkgroup.dataset.folder

        if (!(linklist && linktitle)) {
            throw new Error('Template not found')
        }

        for (const link of group.links) {
            let li = group.lis.find((li) => li.id === link._id)

            if (li) {
                li.removeAttribute('style')
                linklist?.appendChild(li)
                continue
            }

            li = isElem(link)
                ? createElem(link, sync.linknewtab, sync.linkstyle)
                : createFolder(link, linksInFolders, sync.linkstyle)

            fragment.appendChild(li)

            if (!group.synced) {
                li.addEventListener('keyup', openContextMenu)
                li.addEventListener('pointerdown', startDrag)
                li.addEventListener('click', selectAll)
                li.addEventListener('pointerdown', selectAll)
            }
        }

        if (folderid) {
            linktitle.textContent = (sync[folderid] as LinkFolder).title
        } else {
            linktitle.textContent = group.title
        }

        linkgroup.dataset.group = group.title
        linkgroup.classList.toggle('pinned', group.pinned)
        linkgroup.classList.toggle('synced', group.synced)
        linklist.querySelector('.link-add-item')?.remove()
        linklist.appendChild(fragment)
        domlinkblocks.insertBefore(linkgroup, domlinkmini)

        if (group.title === 'topsites') {
            linktitle.textContent = tradThis('Most visited')
            linktitle.classList.add('topsites-title')
            linkgroup.classList.add('topsites-group')
        }

        if (group.title === 'default') {
            linktitle.textContent = tradThis('Default group')
        }
    }

    if (local) {
        createIcons(local)
    } else {
        storage.local.get().then((local) => {
            createIcons(local)
        })
    }

    initFavorites(sync)
    setRadius(sync.linkiconradius)
    updateSelectedGroupPosition()
    displayInterface('links')

    return true
}

export function initFavorites(sync: Sync): void {
    const container = document.getElementById('link-favorites')

    if (!container) {
        return
    }

    // Clear existing favorites
    container.innerHTML = ''

    const favorites = getLinksInGroup(sync, '__favorites')

    for (const link of favorites) {
        if (!isElem(link)) {
            continue
        }

        const li = getHTMLTemplate<HTMLLIElement>('link-elem-template', 'li')
        const span = li.querySelector('span')
        const anchor = li.querySelector('a')

        if (!(li && span && anchor)) {
            continue
        }

        li.id = link._id
        li.classList.add('link-favorite')
        anchor.href = link.url
        span.textContent = createTitle(link)

        if (sync.linknewtab || anchor.href.startsWith('data:')) {
            anchor.target = '_blank'
        }

        container.appendChild(li)
    }

    container.classList.toggle('has-links', favorites.length > 0)
}

function createFolder(link: LinkFolder, folderChildren: Link[], _style: Sync['linkstyle']): HTMLLIElement {
    const li = getHTMLTemplate<HTMLLIElement>('link-folder-template', 'li')
    const imgs = li.querySelectorAll('img')
    const span = li.querySelector('span')

    if (!(li && imgs && span)) {
        throw new Error('Template not found')
    }

    const linksInThisFolder = folderChildren
        .filter((l) => !l.folder && l.parent === link._id)
        .toSorted((a, b) => a.order - b.order)

    li.id = link._id
    span.textContent = createTitle(link)
    li.addEventListener('mouseup', folderClick)
    li.addEventListener('keydown', folderClick)

    for (let i = 0; i < linksInThisFolder.length; i++) {
        const img = imgs[i]
        const elem = linksInThisFolder[i]
        const isIconShown = img && isElem(elem)

        if (isIconShown) {
            initIconList.push([img, getIconFromLinkElem(elem)])
        }
    }

    return li
}

function createElem(link: LinkElem, openInNewtab: boolean, _style: Sync['linkstyle']): HTMLLIElement {
    const li = getHTMLTemplate<HTMLLIElement>('link-elem-template', 'li')
    const span = li.querySelector('span')
    const anchor = li.querySelector('a')
    const img = li.querySelector('img')

    if (!(li && span && anchor && img)) {
        throw new Error('Template not found')
    }

    li.id = link._id
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
        if (url.startsWith('link')) {
            img.src = local[`x-icon-${url}`] ?? ''
        } else {
            img.src = url
        }
    }

    setTimeout(() => {
        // naturalWidth is needed here because complete doesn't tell the whole story
        // it only says if it's finished loading or not, even an error code will say "complete"
        const incomplete = initIconList.filter(
            ([img]) => !img.complete || img.naturalWidth === 0,
        )

        // if images still haven't loaded after 400ms
        for (const [img, url] of incomplete) {
            img.src = 'src/assets/interface/loading.svg'

            const newimg = document.createElement('img')

            newimg.addEventListener('load', () => {
                img.src = url
            })

            // if obvious error (dead link...), shows fallback
            newimg.addEventListener('error', () => {
                img.src = 'https://services.bonjourr.fr/favicon/blob/error'
            })

            newimg.src = url

            // If image still isn't responding after 5s, gives up
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
        text: { width: 5, gap: 2 }, // arbitrary width because width is auto
    }

    if (style in sizes) {
        const { width, gap } = sizes[style as keyof typeof sizes]
        document.documentElement.style.setProperty('--links-width', `${Math.ceil((width + gap) * row)}rem`)
    }
}

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))]
}

//	Select All

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

    // toggle selection
    if (selectAllActive && pointerUpOrClick) {
        if (primaryButton) {
            li?.classList.toggle('selected')
        }

        event.preventDefault()
        return
    }

    // start select all debounce
    if (!selectAllActive && primaryButton && event.type === 'pointerdown') {
        if ((event as PointerEvent)?.pointerType === 'touch') {
            return
        }

        selectallTimer = setTimeout(() => {
            domlinkblocks.classList.add('select-all')
        }, 600)
    }
}

function removeSelectAll(): void {
    clearTimeout(selectallTimer)
    domlinkblocks.classList.remove('select-all')
    for (const li of domlinkblocks.querySelectorAll('.link')) {
        li.classList.remove('selected')
    }
}

// Updates

export async function linksUpdate(update: LinksUpdate): Promise<void> {
    let data = await storage.sync.get()

    if (await syncBookmarksUpdate(update, data)) {
        return
    }

    if (update.addLinks) {
        data = linkSubmission({ type: 'link', links: update.addLinks }, data)
    }
    if (update.addFolder) {
        data = linkSubmission({ type: 'folder', ...update.addFolder }, data)
    }
    if (update.addGroups) {
        data = addGroup(update.addGroups, data)
    }
    if (update.moveLinks) {
        data = moveLinks(update.moveLinks, data)
    }
    if (update.moveFavorites) {
        data = moveFavorites(update.moveFavorites, data)
    }
    if (update.moveGroups) {
        data = moveGroups(update.moveGroups, data)
    }
    if (update.moveToGroup) {
        data = moveToGroup(update.moveToGroup, data)
    }
    if (update.moveToFolder) {
        data = moveToFolder(update.moveToFolder, data)
    }
    if (update.concatFolders) {
        data = concatFolders(update.concatFolders, data)
    }
    if (update.moveOutFolder) {
        data = moveOutFolder(update.moveOutFolder, data)
    }
    if (update.updateLink) {
        data = updateLink(update.updateLink, data)
    }
    if (update.deleteLinks) {
        data = deleteLinks(update.deleteLinks, data)
    }
    if (update.groupTitle) {
        data = changeGroupTitle(update.groupTitle, data)
    }
    if (update.deleteGroup !== undefined) {
        data = deleteGroup(update.deleteGroup, data)
    }
    if (update.unsyncGroup !== undefined) {
        data = unsyncGroup(update.unsyncGroup, data)
    }
    if (update.groups !== undefined) {
        data = toggleGroups(update.groups, data)
    }
    if (update.newtab !== undefined) {
        data = setOpenInNewTab(update.newtab, data)
    }
    if (update.refreshIcons) {
        data = refreshIcons(update.refreshIcons, data)
    }
    if (update.styles) {
        setLinkStyle(update.styles)
    }
    if (update.row) {
        setRows(update.row)
    }
    if (update.iconradius) {
        eventDebounce({ linkiconradius: update.iconradius }) // saving
        setRadius(update.iconradius)
    }

    if (update.styles || update.row) {
        return
    }

    await storage.sync.set(data)
}

function linkSubmission(args: SubmitLink | SubmitFolder, data: Sync): Sync {
    const type = args.type
    let newlinks: Link[] = []

    if (type === 'link') {
        for (const link of args.links) {
            const validated = validateLink(
                link.title,
                link.url,
                // if no group is specified, adds to the selected one
                link.group || data.linkgroups.selected,
            )

            validated.bookmark = link.bookmark
            newlinks.push(validated)
        }
    }

    if (type === 'folder') {
        const { ids, title, group } = args
        newlinks = addLinkFolder(ids, title, group)

        for (const id of ids) {
            const elem = data[id] as Link

            if (elem && !elem.folder) {
                elem.parent = newlinks[0]._id
            }
        }
    }

    // Adds parent if missing from link validation
    for (const link of newlinks) {
        const noParents = link.parent === undefined
        const { selected, synced } = data.linkgroups

        if (noParents && synced.includes(selected)) {
            link.parent = ''
            data.linkgroups.selected = ''
            initGroups(data)
        } else if (noParents) {
            link.parent = selected
        }

        data[link._id] = link
    }

    const newsync = correctLinksOrder(data)

    storage.local.get().then((local) => {
        initblocks(newsync, local)
    })

    return newsync
}

function addLinkFolder(ids: string[], title?: string, group?: string): LinkFolder[] {
    const titledom = document.getElementById('e-title') as HTMLInputElement
    const linktitle = title ?? titledom.value

    titledom.value = ''

    const blocks = [...document.querySelectorAll<HTMLElement>('.link')]
    const idsOnInterface = blocks.map((block) => block.id)
    const order = idsOnInterface.indexOf(ids[0])

    for (let i = 0; i < ids.length; i++) {
        const dom = document.getElementById(ids[i])
        const isFolder = dom?.classList.contains('link-folder')

        if (isFolder) {
            ids.splice(i, 1)
        }
    }

    return [
        {
            _id: `links${randomString(6)}`,
            folder: true,
            order: order,
            parent: group ?? '',
            title: linktitle,
        },
    ]
}

function updateLink({ id, title, icon, url, file }: UpdateLink, data: Sync): Sync {
    const titledom = document.querySelector<HTMLSpanElement>(`#${id} span`)
    const icondom = document.querySelector<HTMLImageElement>(`#${id} img`)
    const urldom = document.querySelector<HTMLAnchorElement>(`#${id} a`)

    const link = data[id] as Link

    if (titledom && title !== undefined) {
        link.title = stringMaxSize(title, 64)
        titledom.textContent = link.title
    }

    if (isElem(link)) {
        if (icondom && icon) {
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
                } else {
                    console.error(`There was a problem with this icon URL: ${icon.value}`)
                }
            }

            if (icon.type === 'file') {
                const currentIcon = link.icon
                const noNewOrCurrentFile = !file && !currentIcon?.value
                const noNewButHasCurrentFile = !file && (currentIcon?.type === 'file') && !!currentIcon?.value

                if (noNewOrCurrentFile) {
                    throw new Error('Chose file but no file uploaded')
                }

                if (noNewButHasCurrentFile) {
                    icon = currentIcon
                    img.src = currentSrc
                }

                if (file) {
                    url = id

                    storeIconFile(id, file).then((uri) => {
                        img.src = uri
                    })
                }
            }

            link.icon = icon
        }

        if (titledom && urldom && url !== undefined) {
            link.url = url
            urldom.href = link.url
            titledom.textContent = createTitle(link)
        }
    }

    data[id] = link

    return data
}

function concatFolders({ target, source }: MoveToFolder, data: Sync): Sync {
    const linktarget = data[target] as Link
    const linksource = data[source] as Link

    if (!(linktarget.folder && linksource.folder)) {
        return data
    }

    const sourceIds = getLinksInFolder(data, source).map(({ _id }) => _id)
    const targetIds = getLinksInFolder(data, target).map(({ _id }) => _id)
    const ids = [...targetIds, ...sourceIds]

    for (const [key, val] of Object.entries(data)) {
        if (isLink(val) === false) {
            continue
        }

        if (ids.includes(val._id) && !val.folder) {
            ;(data[key] as LinkElem).parent = target
            ;(data[key] as LinkElem).order = Date.now()
        }
    }

    delete data[source]
    initblocks(data)

    setTimeout(() => storage.sync.remove(source))

    return data
}

function moveToFolder({ target, source }: MoveToFolder, data: Sync): Sync {
    const isSourceElem = typeof (data[source] as LinkElem)?.url === 'string'
    const isTargetFolder = (data[target] as LinkFolder)?.folder === true

    if (isSourceElem && isTargetFolder) {
        ;(data[source] as LinkElem).parent = target
        ;(data[source] as LinkElem).order = Date.now()
        initblocks(data)
    }

    return data
}

function moveOutFolder({ ids, group }: { ids: string[]; group: string }, data: Sync): Sync {
    // Get the current links in the target group to determine the next order
    const linksInGroup = getLinksInGroup(data, group)
    const maxOrder = linksInGroup.length > 0 ? Math.max(...linksInGroup.map((link) => link.order)) : -1

    // Update each link's parent and order
    ids.forEach((id, index) => {
        ;(data[id] as Link).parent = group
        ;(data[id] as Link).order = maxOrder + index + 1
    })

    const correctdata = correctLinksOrder(data)
    initblocks(correctdata)
    return correctdata
}

function deleteLinks(ids: string[], data: Sync): Sync {
    for (const id of ids) {
        const link = data[id] as Link

        if (link.folder) {
            for (const child of getLinksInFolder(data, link._id)) {
                delete data[child._id]
            }
        }

        if (isElem(link)) {
            if (link.icon?.type === 'file') {
                storage.local.remove(`x-icon-${id}`)
            }
        }

        delete data[id]
    }

    storage.sync.clear()
    const correctdata = correctLinksOrder(data)
    animateLinksRemove(ids)
    return correctdata
}

function moveLinks(ids: string[], data: Sync): Sync {
    ids.forEach((id, i) => {
        ;(data[id] as Link).order = i
    })

    initblocks(data)
    return data
}

function moveFavorites(ids: string[], data: Sync): Sync {
    const existingFavorites = getLinksInGroup(data, FAVORITES_GROUP)
    const existingIds = new Set(existingFavorites.map((l) => l._id))
    const isReorder = ids.every((id) => existingIds.has(id))

    for (const id of ids) {
        const link = data[id] as Link
        if (!isElem(link)) continue

        const oldParent = link.parent as string
        if (data.linkgroups.synced.includes(oldParent)) {
            const hidden = data.linkgroups.hidden[oldParent] ?? []
            if (!hidden.includes(link.url)) {
                hidden.push(link.url)
            }
            data.linkgroups.hidden[oldParent] = hidden
        }

        link.parent = FAVORITES_GROUP
    }

    if (isReorder) {
        // Reorder: set order based on the new ids array
        ids.forEach((id, i) => {
            ;(data[id] as Link).order = i
        })
    } else {
        // Adding new links: append after existing favorites
        const maxOrder = existingFavorites.length > 0 ? Math.max(...existingFavorites.map((l) => l.order)) : -1

        for (const [index, id] of ids.entries()) {
            if (!existingIds.has(id)) {
                ;(data[id] as Link).order = maxOrder + index + 1
            }
        }
    }

    const correctdata = correctLinksOrder(data)
    initblocks(correctdata)
    return correctdata
}

function moveToGroup({ ids, target, source }: MoveToGroup, data: Sync): Sync {
    const targetLinks = getLinksInGroup(data, target)
    const insertAt = source !== undefined ? Number.parseInt(source) : -1

    for (const id of ids) {
        const link = data[id] as Link

        const oldParent = link.parent as string
        if (data.linkgroups.synced.includes(oldParent) && isElem(link)) {
            const hidden = data.linkgroups.hidden[oldParent] ?? []
            if (!hidden.includes(link.url)) {
                hidden.push(link.url)
            }
            data.linkgroups.hidden[oldParent] = hidden
        }

        link.parent = target

        if (insertAt >= 0 && insertAt < targetLinks.length) {
            link.order = targetLinks[insertAt].order - 0.5
        } else {
            link.order = Date.now()
        }
    }

    const correctdata = correctLinksOrder(data)

    if (correctdata.linkgroups.groups.includes(target)) {
        correctdata.linkgroups.selected = target
        initGroups(correctdata)
    }

    initblocks(correctdata)
    return correctdata
}

function refreshIcons(ids: string[], data: Sync): Sync {
    for (const id of ids) {
        const link = data[id] as LinkElem

        if (link._id) {
            const unixDate = Date.now().toString()

            if (!link.icon || link.icon.type === 'auto') {
                link.icon = link.icon ?? { type: 'auto', value: '' } // when link was just added, it doesn't have the icon property, so creates it
                link.icon.value = getDefaultIcon(link.url) + `?r=${unixDate}`
            } else if (link.icon.type === 'url') {
                link.icon.value = `${link.icon.value}?r=${unixDate}`
            }

            data[id] = link
        }
    }

    initblocks(data)

    return data
}

/**
 * Detach a group from `linkgroups.synced` while keeping its current links as a
 * local snapshot. After this, the user can freely rename, reorder, edit, or
 * delete those links — they are no longer mirrored from a browser bookmark
 * folder. Re-enabling sync requires going through the bookmark import dialog.
 *
 * The implicit __favorites group is intentionally not unsync-able from here:
 * its lifecycle is owned by `applyFavoritesFromToolbar` and it never lives in
 * `linkgroups.synced`.
 */
function unsyncGroup(group: string, data: Sync): Sync {
    if (group === FAVORITES_GROUP) {
        return data
    }

    const before = data.linkgroups.synced
    const after = before.filter((g) => g !== group)

    if (after.length === before.length) {
        return data
    }

    data.linkgroups.synced = after

    // Drop the .synced visual marker from the rendered group so the next
    // initblocks pass treats it as a normal editable group. initblocks reads
    // group.synced from data.linkgroups.synced and re-applies the class, so
    // this is just a cosmetic head-start before the re-render.
    const groupDiv = document.querySelector<HTMLDivElement>(
        `.link-group[data-group="${group}"]`,
    )
    groupDiv?.classList.remove('synced')

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

    data.linknewtab = newtab

    return data
}

async function setLinkStyle(
    styles: { style?: string; titles?: boolean; backgrounds?: boolean },
): Promise<void> {
    const data = await storage.sync.get()
    const style = styles.style ?? 'inline'
    const { titles } = styles
    const { backgrounds } = styles

    if (styles.style && isLinkStyle(style)) {
        domlinkblocks.classList.remove('inline', 'text')
        domlinkblocks.classList.add(style)

        data.linkstyle = style
        storage.sync.set({ linkstyle: style })

        initRows(data.linksrow, style)
    }

    if (typeof titles === 'boolean') {
        data.linktitles = titles
        storage.sync.set({ linktitles: titles })

        domlinkblocks.classList.toggle('titles', titles)
    }

    if (typeof backgrounds === 'boolean') {
        data.linkbackgrounds = backgrounds
        storage.sync.set({ linkbackgrounds: backgrounds })

        domlinkblocks.classList.toggle('backgrounds', backgrounds)
    }
}

function setRadius(radius: string | number): void {
    document.documentElement.style.setProperty('--link-outer-radius', `${radius}em`)
}

function setRows(row: string): void {
    const style = [...domlinkblocks.classList].filter(isLinkStyle)[0] ?? 'inline'
    const val = Number.parseInt(row ?? '6')
    initRows(val, style)
    eventDebounce({ linksrow: row })
}

// Helpers

export function validateLink(title: string, url: string, parent?: string): LinkElem {
    const startsWithEither = (strs: string[]) => strs.some((str) => url.startsWith(str))

    const isConfig = startsWithEither(['about:', 'chrome://', 'edge://'])
    const hasOwnProtocol = startsWithEither(['https://', 'http://', 'data:', 'ftp:'])
    const isLocalhost = url.startsWith('localhost') || url.startsWith('127.0.0.1')
    const prefix = isConfig ? '#' : isLocalhost ? 'http://' : !hasOwnProtocol ? 'https://' : ''

    return {
        _id: `links${randomString(6)}`,
        parent,
        order: Date.now(), // big number
        title: stringMaxSize(title, 64),
        url: prefix + url,
    }
}

function animateLinksRemove(ids: string[]): void {
    for (const id of ids) {
        document.getElementById(id)?.classList.add('removed')
        setTimeout(() => document.getElementById(id)?.remove(), 600)
    }
}

function correctLinksOrder(data: Sync): Sync {
    const allLinks = Object.values(data).filter((val) => isLink(val)) as Link[]
    const folderIds = allLinks.filter((link) => link.folder).map(({ _id }) => _id)

    for (const folderId of folderIds) {
        const linksInFolder = getLinksInFolder(data, folderId)

        for (const [i, link] of linksInFolder.entries()) {
            link.order = i
            data[link._id]
        }
    }

    for (const group of [...data.linkgroups.groups, FAVORITES_GROUP]) {
        const linksInGroup = getLinksInGroup(data, group)

        for (const [i, link] of linksInGroup.entries()) {
            link.order = i
            data[link._id]
        }
    }

    return data
}

function getIconFromLinkElem(link: LinkElem): string {
    if (!link.icon?.value) {
        try {
            const url = new URL(link.url)
            if (url.protocol === 'data:') {
                return link._id // no favicon to fetch for data URLs
            }
            return getDefaultIcon(url.origin + url.pathname)
        } catch (_) {
            return getDefaultIcon(link.url)
        }
    }

    if (link.icon.type === 'file') {
        return link._id
    }

    return link.icon.value
}

function isLinkStyle(s: string): s is Sync['linkstyle'] {
    return ['inline', 'text'].includes(s)
}

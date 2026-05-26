import { createElem, createIcons, createSubfolderElement } from './index.ts'
import { getLiFromEvent, isElem, isSubfolder } from './helpers.ts'
import { getSubfolder } from './model.ts'

import { storage } from '../../storage.ts'

import type { Local } from '../../../types/local.ts'
import type { LinkNode } from '../../../types/shared.ts'
import type { Sync } from '../../../types/sync.ts'

const domlinkblocks = document.getElementById('linkblocks') as HTMLUListElement

interface OpenPanel {
    panel: HTMLElement
    opener: HTMLElement
    container: HTMLElement
}

const openPanels: OpenPanel[] = []
let outsideListener: ((event: MouseEvent) => void) | null = null
let scrollListener: (() => void) | null = null
let resizeListener: (() => void) | null = null

export async function folderClick(event: MouseEvent | KeyboardEvent): Promise<void> {
    const li = getLiFromEvent(event)

    let rightClick = false

    if (event instanceof MouseEvent) {
        rightClick = event.button === 2
    } else if (event instanceof KeyboardEvent) {
        // Only treat Enter/Space as activation; ignore everything else so the
        // user can still type-search etc. Don't recurse here — the original
        // code called folderClick(event) again, which infinitely recursed
        // because the same KeyboardEvent re-entered this branch.
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
    }

    const inFolder = li?.classList.contains('link-folder')
    const isSelectAll = domlinkblocks.className.includes('select-all')

    if (!(li && inFolder) || rightClick || isSelectAll) {
        return
    }

    document.dispatchEvent(new Event('stop-select-all'))

    const [data, local] = await Promise.all([storage.sync.get(), storage.local.get()])
    openFolder(data, local, li)
}

function openFolder(data: Sync, local: Local, li: HTMLLIElement): void {
    const linkgroup = li.closest<HTMLElement>('.link-group')
    if (!linkgroup) return

    const folder = getSubfolder(data, li.id)
    if (!folder) return

    const wasExpanded = li.classList.contains('expanded')
    const level = findContainerLevel(li)

    while (openPanels.length > level) {
        const entry = openPanels.pop()
        if (!entry) break
        entry.panel.remove()
        entry.opener.classList.remove('expanded')
    }

    if (wasExpanded) {
        if (openPanels.length === 0) detachListeners()
        return
    }

    li.classList.add('expanded')

    const panel = document.createElement('ul')
    panel.className = 'link-subfolder-panel'
    renderPanelItems(panel, folder.items, data.links.newTab)
    linkgroup.appendChild(panel)
    positionPanel(panel, li, linkgroup)

    // Resolve favicons for the freshly-rendered <img>s. createElem queues each
    // image into the shared init list; createIcons drains it now so panel
    // links don't render with broken-image placeholders.
    createIcons(local)

    openPanels.push({ panel, opener: li, container: linkgroup })
    attachListeners()
}

function findContainerLevel(li: HTMLElement): number {
    for (let i = openPanels.length - 1; i >= 0; i--) {
        if (openPanels[i].panel.contains(li)) {
            return i + 1
        }
    }
    return 0
}

// The panel pops out from the right edge of its anchor list (the parent
// .link-list at the top level, or the parent .link-subfolder-panel for
// nested levels). Anchoring on the LIST — not on the clicked <li> — avoids
// overlapping the parent because the list has horizontal padding that an
// <li>-relative offset would silently land inside.
//
// Vertically, the panel is BOTTOM-aligned to the clicked <li> so it grows
// upward — matching the rest of the popup which expands upward from the
// bottom mini-bar.
//
// Horizontal gap = 2px: 1px lands on the linkgroup's 1px border, leaving
// 1px of visible breathing room without pushing the panel visibly far away.
function positionPanel(panel: HTMLElement, anchor: HTMLElement, container: HTMLElement): void {
    const parentList = anchor.closest<HTMLElement>('.link-list, .link-subfolder-panel') ?? anchor
    const a = anchor.getBoundingClientRect()
    const list = parentList.getBoundingClientRect()
    const c = container.getBoundingClientRect()

    panel.style.left = `${list.right - c.left + 2}px`
    panel.style.top = 'auto'
    panel.style.bottom = `${c.bottom - a.bottom}px`
}

function repositionAll(): void {
    for (const entry of openPanels) {
        positionPanel(entry.panel, entry.opener, entry.container)
    }
}

export function collapseAllPanels(): void {
    while (openPanels.length > 0) {
        const entry = openPanels.pop()
        if (!entry) break
        entry.panel.remove()
        entry.opener.classList.remove('expanded')
    }
    detachListeners()
}

function attachListeners(): void {
    if (!outsideListener) {
        const handler = (event: MouseEvent) => {
            const target = event.target as Element | null
            if (!target) return
            const insidePanel = openPanels.some((p) => p.panel.contains(target))
            const onFolderTrigger = target.closest('.link-folder')
            if (insidePanel || onFolderTrigger) return
            collapseAllPanels()
        }
        outsideListener = handler
        // Defer registration so the same mousedown that opened the panel
        // doesn't close it on the very next event-loop tick.
        setTimeout(() => {
            if (outsideListener === handler) {
                document.addEventListener('mousedown', handler)
            }
        }, 0)
    }

    if (!scrollListener) {
        scrollListener = repositionAll
        // Capture-phase to catch scrolls inside any nested overflow container
        // (e.g. the parent .link-list with overflow:auto).
        globalThis.addEventListener('scroll', scrollListener, { capture: true, passive: true })
    }

    if (!resizeListener) {
        resizeListener = repositionAll
        globalThis.addEventListener('resize', resizeListener)
    }
}

function detachListeners(): void {
    if (outsideListener) {
        document.removeEventListener('mousedown', outsideListener)
        outsideListener = null
    }
    if (scrollListener) {
        globalThis.removeEventListener('scroll', scrollListener, true)
        scrollListener = null
    }
    if (resizeListener) {
        globalThis.removeEventListener('resize', resizeListener)
        resizeListener = null
    }
}

function renderPanelItems(ul: HTMLElement, items: LinkNode[], newTab: boolean): void {
    const sorted = [...items].sort((a, b) => {
        return (isSubfolder(a) ? 1 : 0) - (isSubfolder(b) ? 1 : 0)
    })

    for (const item of sorted) {
        if (isElem(item)) {
            const li = createElem(item, newTab)
            // Close the popover stack after the user follows a link, so we
            // don't leave a dangling panel behind on the new tab page.
            li.querySelector('a')?.addEventListener('click', () => {
                setTimeout(collapseAllPanels, 100)
            })
            ul.appendChild(li)
        } else if (isSubfolder(item)) {
            ul.appendChild(createSubfolderElement(item))
        }
    }
}

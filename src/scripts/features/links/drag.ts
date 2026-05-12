import { getLiFromEvent, getTitleFromEvent } from './helpers.ts'
import { FAVORITES_GROUP, initblocks, linksUpdate } from './index.ts'
import { setGroupFocus, updateSelectedFolderPosition } from './groups.ts'
import { openFolder } from './folders.ts'
import { storage } from '../../storage.ts'

type Coords = { x: number; y: number; w: number; h: number }
type DropType = 'mini' | 'link' | 'group'
type DropArea = 'left' | 'right' | 'center' | ''
type Dropzones = Map<string, Coords>
type LinkDropDirection = 'horizontal' | 'vertical'
type DropzoneHit = { area: DropArea; id: string }
type PendingDragAnchor = {
    id: string
    x: number
    y: number
    target: HTMLElement
    type: 'mini' | 'link'
}

const GROUP_HOVER_DELAY = 300
const MINI_HOVER_PADDING_Y = 0
const FAVORITES_DROP_HEIGHT = 32
const SLOT_CROSS_AXIS_PADDING = 24
const SLOT_MAIN_AXIS_PADDING = 32
const DROP_EDGE_RATIO = 0.3

const blocks: Map<string, HTMLElement> = new Map()
const originRects: Map<string, Coords> = new Map()
const groups: Map<string, HTMLElement> = new Map()
const dropzones: Record<DropType, Dropzones> = { group: new Map(), link: new Map(), mini: new Map() }

let [dx, dy, cox, coy, lastIndex] = [0, 0, 0, 0, 0, 0]
let lastdropAreas: DropArea[] = ['']
let draggedId = ''
let targetId = ''
let targetGroup = ''
let crossGroupTarget = ''
let pendingGroupTarget = ''
let originalGroup = ''
let ids: string[] = []
let coords: Coords[] = []
let dragContainers: NodeListOf<HTMLElement>
let dragChangeParentTimeout = 0
let dragAnimationFrame = 0
let groupHoverToken = 0
let dragLayer: HTMLDivElement | undefined
let layeredIds: Set<string> = new Set()
let isDragging = false
let overFavorites = false
let isFavoritesDrag = false
let linkDropDirection: LinkDropDirection = 'vertical'
let pendingDragAnchor: PendingDragAnchor | undefined
let shouldPreventNextClick = false

const domlinkblocks = document.getElementById('linkblocks') as HTMLDivElement
const domlinkfavorites = document.getElementById('link-favorites') as HTMLDivElement
let domlinklinks: NodeListOf<HTMLLIElement>
let domlinktitles: NodeListOf<HTMLButtonElement>
let domlinkgroups: NodeListOf<HTMLDivElement>
let domlinkgroup: HTMLDivElement

queueMicrotask(() => {
    document.getElementById('link-mini')?.addEventListener('pointerdown', (event) => {
        const target = getTitleFromEvent(event)
        if (!target || target.classList.contains('add-group') || target.classList.contains('synced')) return
        startDrag(event)
    })
})

export function startDrag(event: PointerEvent): void {
    const path = event.composedPath() as HTMLElement[]
    const type = path.some((el) => el?.classList?.contains('link-title')) ? 'mini' : 'link'
    const dragType = event.type === 'pointerdown' ? type : pendingDragAnchor?.type ?? type
    const isMini = dragType === 'mini'
    const tagName = isMini ? 'BUTTON' : 'LI'
    const eventTarget = path.find((n) => {
        if (n.tagName !== tagName) return false
        return isMini ? n.classList.contains('link-title') : n.classList.contains('link')
    })
    const target = event.type === 'pointerdown' ? eventTarget : pendingDragAnchor?.target ?? eventTarget
    const nextDraggedId = target ? findIdFromElement(target, isMini ? 'mini' : 'link') : ''

    if (event.button > 0) return
    if (event.type === 'pointerdown') {
        beforeStartDrag(event, dragType)
        return
    }
    if (!(target && nextDraggedId)) {
        pendingDragAnchor = undefined
        return
    }

    ids = []
    coords = []
    lastdropAreas = []
    lastIndex = 0
    targetId = ''
    isDragging = true
    overFavorites = false
    crossGroupTarget = ''
    pendingGroupTarget = ''
    groupHoverToken = 0
    isFavoritesDrag = !!path.find((n) => n?.id === 'link-favorites')
    linkDropDirection = isFavoritesDrag ? 'horizontal' : 'vertical'
    blocks.clear()
    originRects.clear()
    groups.clear()
    dropzones.group.clear()
    dropzones.link.clear()
    dropzones.mini.clear()
    layeredIds = new Set()
    dragLayer?.remove()
    dragLayer = document.createElement('div')
    dragLayer.className = 'links-drag-layer'
    domlinkblocks.appendChild(dragLayer)

    if (isMini) {
        setGroupFocus(false)
    }

    domlinkgroup = path.find((n) => n?.classList?.contains('link-group')) as HTMLDivElement
    domlinkgroups = document.querySelectorAll('#linkblocks .link-group')
    domlinklinks = document.querySelectorAll(isFavoritesDrag ? '#link-favorites li' : '#linkblocks .link-group li')
    domlinktitles = document.querySelectorAll('#link-mini button:not(.add-group)')

    const selector = isFavoritesDrag ? '#link-favorites' : isMini ? '#link-mini' : '.link-group'
    dragContainers = document.querySelectorAll(selector)

    const pos = getPosFromEvent(event)
    draggedId = nextDraggedId
    originalGroup = isFavoritesDrag
        ? FAVORITES_GROUP
        : isMini
        ? findIdFromElement(target, 'mini')
        : domlinkgroup?.dataset.group ?? ''
    targetGroup = originalGroup

    collectDropzones(isMini)
    initContainerElements(isMini, tagName, pos)
    if (isMini) placeMiniTabsInSingleRow()
    lastIndex = ids.indexOf(draggedId)

    if (!isMini && !isFavoritesDrag) {
        domlinkblocks.classList.add('favorites-drop-active')
        domlinkfavorites?.classList.add('drop-target')
    }

    requestAnimationFrame(() => {
        for (const [id, block] of blocks) {
            if (id !== draggedId) {
                block.style.transition = ''
                const orig = document.getElementById(id)
                if (orig && orig !== block) orig.style.transition = ''
            }
        }
    })

    document.dispatchEvent(new Event('remove-select-all'))
    preventNextClick()
    dragAnimationFrame = globalThis.requestAnimationFrame(deplaceDraggedElem)

    document.documentElement.addEventListener('pointermove', moveDrag)
    document.documentElement.addEventListener('pointerup', endDrag)
    document.documentElement.addEventListener('pointercancel', endDrag)
    document.documentElement.addEventListener('pointerleave', endDrag)
    globalThis.addEventListener('pointerup', endDrag)
    globalThis.addEventListener('pointercancel', endDrag)
    globalThis.addEventListener('blur', endDrag)

    if (event.pointerType === 'touch') {
        document.documentElement.addEventListener('touchmove', moveDrag, { passive: false })
        document.documentElement.addEventListener('touchend', endDrag, { passive: false })
        document.documentElement.addEventListener('touchcancel', endDrag, { passive: false })
    }
}

function collectDropzones(isMini: boolean): void {
    const elements = isMini ? [...domlinktitles] : [...domlinkgroups, ...domlinktitles, ...domlinklinks]

    for (const el of elements) {
        const t = findTypeFromElement(el)
        const r = el.getBoundingClientRect()
        const id = findIdFromElement(el)
        if (t !== 'group') blocks.set(id, el)
        else groups.set(id, el)
        dropzones[t].set(id, { x: r.x, y: r.y, h: r.height, w: r.width })
    }
}

function initContainerElements(isMini: boolean, tagName: string, pos: { x: number; y: number }): void {
    for (const container of Object.values(dragContainers)) {
        const elements = isMini
            ? container.querySelectorAll<HTMLElement>('button:not(.add-group)')
            : container.querySelectorAll<HTMLElement>(tagName)
        const wrapper = isMini
            ? container
            : isFavoritesDrag
            ? container
            : container.querySelector<HTMLElement>('.link-list')
        const rect = wrapper?.getBoundingClientRect()
        if (!(wrapper && rect)) continue

        for (const element of elements) {
            const t = findTypeFromElement(element)
            const id = findIdFromElement(element, t)
            const c = dropzones[t].get(id) ?? { x: 0, y: 0, w: 0, h: 0 }
            ids.push(id)
            coords.push({ ...c })
            const useDragLayer = isMini || id === draggedId
            const block = useDragLayer ? createDragClone(element, c) : element
            if (useDragLayer) {
                layeredIds.add(id)
                dragLayer?.appendChild(block)
            }
            blocks.set(id, block)
            originRects.set(id, { ...c })
            element.style.transition = 'none'
            block.style.transition = 'none'
            if (useDragLayer) {
                element.style.visibility = 'hidden'
                deplaceElem(block, c.x, c.y)
            }
            if (id === draggedId) {
                const anchor = pendingDragAnchor?.id === draggedId ? pendingDragAnchor : undefined

                cox = anchor?.x ?? pos.x - c.x
                coy = anchor?.y ?? pos.y - c.y
                dx = pos.x - cox
                dy = pos.y - coy
                block.classList.add('on')
            }
        }
        container.style.setProperty('--drag-width', `${rect.width}px`)
        container.style.setProperty('--drag-height', `${rect.height}px`)
        container.classList.add('in-drag', 'dragging')
    }
}

function beforeStartDrag(event: PointerEvent, type: 'mini' | 'link'): void {
    const target = type === 'mini' ? getTitleFromEvent(event) : getLiFromEvent(event)
    if (!target) return

    const rect = target.getBoundingClientRect()
    const pointerX = event.clientX
    const pointerY = event.clientY

    pendingDragAnchor = {
        id: findIdFromElement(target, type),
        x: Math.max(0, Math.min(pointerX - rect.left, rect.width)),
        y: Math.max(0, Math.min(pointerY - rect.top, rect.height)),
        target,
        type,
    }

    document.documentElement.addEventListener('pointermove', dz)
    document.documentElement.addEventListener('pointerup', dz)
    document.documentElement.addEventListener('pointercancel', dz)
    function dz(ev: PointerEvent): void {
        const p = ev.pointerType === 'touch' ? 7 : 14
        const ox = Math.abs(pointerX - ev.clientX)
        const oy = Math.abs(pointerY - ev.clientY)
        if (ox > p / 2 || oy > p / 2) document.dispatchEvent(new Event('stop-select-all'))
        if (ox > p || oy > p) startDrag(ev)
        if (ox > p || oy > p || ev.type.includes('pointerup') || ev.type.includes('pointercancel')) {
            if (ev.type.includes('pointerup') || ev.type.includes('pointercancel')) {
                pendingDragAnchor = undefined
            }
            document.documentElement.removeEventListener('pointermove', dz)
            document.documentElement.removeEventListener('pointerup', dz)
            document.documentElement.removeEventListener('pointercancel', dz)
        }
    }
}

function isOverFavoritesBar(x: number, y: number): boolean {
    if (!domlinkfavorites) return false

    const r = domlinkfavorites?.getBoundingClientRect()
    const hasVisibleFavorites = domlinkfavorites.classList.contains('has-links') || r.height > 0

    if (hasVisibleFavorites && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
        return true
    }

    const mini = document.getElementById('link-mini')?.getBoundingClientRect()
    if (!mini) return false

    return x >= mini.x && x <= mini.x + mini.width && y >= mini.bottom && y <= mini.bottom + FAVORITES_DROP_HEIGHT
}

function moveDrag(event: TouchEvent | PointerEvent): void {
    if (event.cancelable) event.preventDefault()

    const { x, y } = getPosFromEvent(event)
    dx = x - cox
    dy = y - coy

    if (draggedId.startsWith('links') && !isFavoritesDrag) {
        overFavorites = isOverFavoritesBar(x, y)
        if (overFavorites) {
            cancelPendingGroupHover()
            targetId = ''
            markMiniTabDropTarget('')
            return
        }
    }

    const result = isDraggingOver({ x, y })
    const [curr, id, type] = result ?? ['', '']
    const last = lastdropAreas[lastdropAreas.length - 1]
    const isDraggingMiniTab = !draggedId.startsWith('links')

    if (type === 'mini' && !isDraggingMiniTab) {
        handleMiniTabHover(id)
        if (last !== curr) lastdropAreas.push(curr)
        return
    }

    // When hovering over a link-group div (not mini tab), handle group-level drop
    if (type === 'group') {
        targetGroup = id
        if (targetGroup !== originalGroup) applyDragChangeParent(id, 'group')
        if (targetGroup === originalGroup) {
            for (const b of blocks.values()) b.classList.remove('drop-target', 'drop-source')
            for (const b of groups.values()) b.classList.remove('drop-target', 'drop-source')
        }
        return
    }

    // After a cross-group switch, allow reordering within the new group
    const isInCrossGroup = crossGroupTarget !== '' && crossGroupTarget !== originalGroup

    // Block reordering only when hovering over a different group's area (not after switch)
    if (targetGroup !== originalGroup && !isInCrossGroup) return

    if (curr === '') {
        lastdropAreas.push('')
        cancelPendingGroupHover()
        targetId = ''
        targetGroup = originalGroup
        markMiniTabDropTarget('')
        for (const b of blocks.values()) b.classList.remove('drop-target', 'drop-source')
        for (const b of groups.values()) b.classList.remove('drop-target', 'drop-source')
        return
    }

    targetGroup = crossGroupTarget || originalGroup

    const staysInCenter = last === curr && curr === 'center'
    if (staysInCenter && type === 'mini') handleMiniTabHover(id)
    if (staysInCenter && type === 'link') {
        applyDragChangeParent(id, type)
    }
    if ((type === 'link' || type === 'mini') && (curr === 'left' || curr === 'right')) {
        applyDragMoveBlocks(id, curr)
    }
    if (last !== curr) lastdropAreas.push(curr)
}

function handleMiniTabHover(groupName: string): void {
    // Only switch groups when dragging a link, not when dragging mini tabs
    const isDraggingMiniTab = !draggedId.startsWith('links')
    if (isDraggingMiniTab) {
        applyDragChangeParent(groupName, 'mini')
        return
    }

    targetId = groupName

    const selectedGroup = document.querySelector<HTMLElement>('#link-mini .link-title.selected-group')?.dataset.group
    if (selectedGroup === groupName && crossGroupTarget === '') {
        markMiniTabDropTarget('')
        return
    }

    // Don't re-switch to the same group
    if (crossGroupTarget === groupName) return
    if (pendingGroupTarget === groupName) return
    pendingGroupTarget = groupName
    markMiniTabDropTarget(groupName)

    clearTimeout(dragChangeParentTimeout)
    const token = ++groupHoverToken
    dragChangeParentTimeout = setTimeout(async () => {
        if (token !== groupHoverToken) return

        crossGroupTarget = groupName
        pendingGroupTarget = ''

        // Switch the selected group visually (don't persist to storage)
        const buttons = document.querySelectorAll<HTMLElement>('#link-mini button')
        for (const btn of buttons) btn.classList.remove('selected-group')
        findMiniTabButton(groupName)?.classList.add('selected-group')

        // Rebuild the group's links visually without persisting
        const data = await storage.sync.get()
        if (token !== groupHoverToken) return

        const savedSelected = data.links.selectedFolder
        data.links.selectedFolder = groupName
        initblocks(data)
        // Restore the original selected folder in storage (don't persist the switch)
        data.links.selectedFolder = savedSelected
        setGroupFocus(true)
        updateSelectedFolderPosition()

        // Re-collect dropzones for the new group's links
        rebuildDragState()
    }, GROUP_HOVER_DELAY)
}

function cancelPendingGroupHover(): void {
    clearTimeout(dragChangeParentTimeout)
    pendingGroupTarget = ''
    groupHoverToken += 1
}

function findMiniTabButton(groupName: string): HTMLElement | undefined {
    return [...document.querySelectorAll<HTMLElement>('#link-mini .link-title')]
        .find((button) => button.dataset.group === groupName)
}

function markMiniTabDropTarget(groupName: string): void {
    for (const button of document.querySelectorAll<HTMLElement>('#link-mini .link-title')) {
        button.classList.toggle('drop-target', button.dataset.group === groupName)
    }
}

function rebuildDragState(): void {
    const draggedBlock = blocks.get(draggedId)
    const draggedOrigin = originRects.get(draggedId)

    // Clear old link dropzones and blocks (keep mini/group zones intact)
    for (const id of [...dropzones.link.keys()]) {
        dropzones.link.delete(id)
        if (id !== draggedId) {
            blocks.delete(id)
            originRects.delete(id)
        }
    }

    if (draggedBlock) blocks.set(draggedId, draggedBlock)
    if (draggedOrigin) originRects.set(draggedId, draggedOrigin)

    // Reset position arrays
    ids = []
    coords = []
    lastIndex = 0
    lastdropAreas = []
    linkDropDirection = 'vertical'

    // Update DOM references — only collect links inside .link-group, not favorites
    domlinkgroups = document.querySelectorAll('#linkblocks .link-group')
    domlinklinks = document.querySelectorAll('#linkblocks .link-group li')
    domlinkgroup = document.querySelector('#linkblocks .link-group:not(.pinned)') as HTMLDivElement

    // Re-collect link dropzones from the new group
    for (const li of domlinklinks) {
        const r = li.getBoundingClientRect()
        const id = li.id
        if (!id) continue
        blocks.set(id, li)
        dropzones.link.set(id, { x: r.x, y: r.y, h: r.height, w: r.width })
        originRects.set(id, { x: r.x, y: r.y, h: r.height, w: r.width })
        ids.push(id)
        coords.push({ x: r.x, y: r.y, w: r.width, h: r.height })
    }

    // Add the dragged element into the ids list so reordering works
    // Insert at the end by default — user can then drag to reposition
    if (!ids.includes(draggedId)) {
        ids.push(draggedId)
        // Use a dummy coord (the dragged element follows the cursor anyway)
        const lastCoord = coords.length > 0 ? coords[coords.length - 1] : { x: 0, y: 0, w: 0, h: 0 }
        coords.push({ x: lastCoord.x, y: lastCoord.y + lastCoord.h, w: lastCoord.w, h: lastCoord.h })
    }

    lastIndex = ids.indexOf(draggedId)

    // Mark the new group container as in-drag
    dragContainers = document.querySelectorAll('.link-group')
    for (const container of dragContainers) {
        container.classList.add('in-drag', 'dragging')
    }
}

function applyDragMoveBlocks(id: string, area: DropArea): void {
    const currentIndex = ids.indexOf(draggedId)
    const targetIndex = ids.indexOf(id)

    if (targetIndex < 0 || currentIndex < 0) return

    cancelPendingGroupHover()

    let nextIndex = area === 'right' ? targetIndex + 1 : targetIndex

    if (currentIndex < nextIndex) {
        nextIndex -= 1
    }

    nextIndex = Math.max(0, Math.min(nextIndex, ids.length - 1))

    if (currentIndex === nextIndex || lastIndex === nextIndex) return

    lastIndex = nextIndex
    ids.splice(currentIndex, 1)
    ids.splice(nextIndex, 0, draggedId)

    if (!draggedId.startsWith('links')) {
        coords = measureMiniTabCoords(ids) ?? coords
    }

    for (let i = 0; i < ids.length; i++) {
        if (ids[i] !== draggedId) deplaceBlock(ids[i], coords[i])
    }
}

function measureMiniTabCoords(order: string[]): Coords[] | undefined {
    const miniInner = document.querySelector<HTMLElement>('#link-mini > div')
    const miniRect = miniInner?.getBoundingClientRect()
    if (!(miniInner && miniRect)) return

    const styles = getComputedStyle(miniInner)
    const measure = document.createElement('div')
    measure.style.position = 'fixed'
    measure.style.left = `${miniRect.x}px`
    measure.style.top = `${miniRect.y}px`
    measure.style.width = `${miniRect.width}px`
    measure.style.visibility = 'hidden'
    measure.style.pointerEvents = 'none'
    measure.style.zIndex = '-1'
    measure.style.boxSizing = styles.boxSizing
    measure.style.display = styles.display
    measure.style.flexWrap = 'nowrap'
    measure.style.justifyContent = styles.justifyContent
    measure.style.alignItems = styles.alignItems
    measure.style.columnGap = styles.columnGap
    measure.style.rowGap = styles.rowGap
    measure.style.padding = styles.padding
    measure.style.overflow = 'visible'

    const elements = new Map<string, HTMLElement>()
    for (const id of order) {
        const source = blocks.get(id)
        const size = originRects.get(id)
        if (!(source && size)) continue

        const clone = source.cloneNode(true) as HTMLElement
        clone.style.display = 'block'
        clone.style.flex = '0 0 auto'
        clone.style.width = `${Math.ceil(size.w)}px`
        clone.style.height = `${Math.ceil(size.h)}px`
        clone.style.margin = '0'
        clone.style.transform = 'none'
        measure.appendChild(clone)
        elements.set(id, clone)
    }

    document.body.appendChild(measure)

    const nextCoords = order.map((id) => {
        const fallback = originRects.get(id) ?? { x: 0, y: 0, w: 0, h: 0 }
        const rect = elements.get(id)?.getBoundingClientRect()
        return rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : fallback
    })

    measure.remove()
    return nextCoords
}

function placeMiniTabsInSingleRow(): void {
    coords = measureMiniTabCoords(ids) ?? coords
    for (let i = 0; i < ids.length; i++) {
        if (ids[i] !== draggedId) deplaceBlock(ids[i], coords[i])
    }
}

function preventNextClick(): void {
    if (shouldPreventNextClick) return
    shouldPreventNextClick = true
    document.addEventListener('click', stopNextClick, true)
}

function stopNextClick(event: MouseEvent): void {
    shouldPreventNextClick = false
    event.preventDefault()
    event.stopImmediatePropagation()
    document.removeEventListener('click', stopNextClick, true)
}

function applyDragChangeParent(id: string, type: DropType): void {
    const delay = type === 'group'
        ? 0
        : Number.parseInt(getComputedStyle(domlinkblocks).getPropertyValue('--drop-delay') || '120')
    cancelPendingGroupHover()
    dragChangeParentTimeout = setTimeout(() => {
        if (id === draggedId || domlinkgroup?.classList.contains('in-folder')) return
        if (type === 'mini') {
            const sel = document.querySelector<HTMLElement>('#link-mini .link-title.selected-group')
            if ((sel?.dataset.group ?? id) === id) return
        }
        targetId = id
        for (const b of blocks.values()) b.classList.remove('drop-target', 'drop-source')
        for (const b of groups.values()) b.classList.remove('drop-target', 'drop-source')
        blocks.get(draggedId)?.classList.toggle('drop-source', true)
        if (type === 'group') groups.get(id)?.classList.toggle('drop-target', true)
        else blocks.get(id)?.classList.toggle('drop-target', true)
    }, delay)
}

function endDrag(event: Event): void {
    if (!isDragging) return
    isDragging = false

    event.preventDefault()
    document.documentElement.removeEventListener('pointermove', moveDrag)
    document.documentElement.removeEventListener('pointerup', endDrag)
    document.documentElement.removeEventListener('pointercancel', endDrag)
    document.documentElement.removeEventListener('pointerleave', endDrag)
    document.documentElement.removeEventListener('touchmove', moveDrag)
    document.documentElement.removeEventListener('touchend', endDrag)
    document.documentElement.removeEventListener('touchcancel', endDrag)
    globalThis.removeEventListener('pointerup', endDrag)
    globalThis.removeEventListener('pointercancel', endDrag)
    globalThis.removeEventListener('blur', endDrag)
    cancelPendingGroupHover()
    markMiniTabDropTarget('')
    pendingDragAnchor = undefined

    const path = event.composedPath() as Element[]
    const type = findTypeFromElement(blocks.get(draggedId))
    const group = domlinkgroup?.dataset.group ?? ''
    const newIndex = ids.indexOf(draggedId)
    const coord = coords[newIndex] ?? originRects.get(draggedId) ?? { x: dx, y: dy, w: 0, h: 0 }

    const isDroppable = !!document.querySelector('.drop-source')
    const outOfFolder = !path[0]?.classList.contains('link-list') && domlinkgroup?.classList.contains('in-folder')
    const targetIdIsLink = targetId.startsWith('links') && targetId.length === 11
    const targetIsFolder = blocks.get(targetId)?.classList.contains('link-folder')
    const draggedIsFolder = blocks.get(draggedId)?.classList.contains('link-folder')
    const toFolder = isDroppable && targetIdIsLink && targetIsFolder && !draggedIsFolder
    const toTab = targetId !== '' && targetId !== originalGroup && !targetIdIsLink
    const toFavorites = overFavorites && draggedId.startsWith('links')
    // Use originalGroup to detect cross-group (not draggedGroup which no longer exists)
    const isCrossGroup = crossGroupTarget !== '' && crossGroupTarget !== originalGroup

    globalThis.cancelAnimationFrame(dragAnimationFrame)
    blocks.get(draggedId)?.classList.remove('on')
    domlinkblocks.classList.remove('favorites-drop-active')
    domlinkfavorites?.classList.remove('drop-target')
    for (const container of dragContainers) container?.classList.replace('dragging', 'dropping')

    // For cross-group: the element was removed from old group DOM, just animate removal
    if (isCrossGroup || outOfFolder || toFolder || toTab || toFavorites) {
        blocks.get(draggedId)?.classList.add('removed')
    } else {
        const dragBlock = blocks.get(draggedId)
        if (dragBlock) dragBlock.style.transition = 'transform 0.2s cubic-bezier(0.2, 0, 0, 1)'
        deplaceBlock(draggedId, coord)
    }

    for (const b of groups.values()) b.classList.remove('drop-target', 'drop-source')
    markMiniTabDropTarget('')

    const updateDelay = isCrossGroup || toTab || toFavorites || toFolder ? 0 : 200

    setTimeout(() => {
        if (type === 'mini') {
            linksUpdate({ moveFolders: ids })
        } else if (toFavorites) {
            linksUpdate({ moveFavorites: [draggedId] })
        } else if (toFolder) {
            linksUpdate({ moveToFolder: { source: draggedId, target: targetId } })
            // Auto-open the folder after dropping a link into it
            setTimeout(() => {
                const folderLi = document.getElementById(targetId) as HTMLLIElement
                if (folderLi) {
                    storage.sync.get().then((data) => openFolder(data, folderLi))
                }
            }, 300)
        } else if (isCrossGroup) {
            // Move to the new group at the position the user chose
            const position = ids.indexOf(draggedId)
            linksUpdate({ moveToFolder: { ids: [draggedId], target: crossGroupTarget, source: position.toString() } })
        } else if (toTab) {
            linksUpdate({ moveToFolder: { ids: [draggedId], target: targetId } })
        } else if (outOfFolder) {
            linksUpdate({ moveOutSubfolder: { ids: [draggedId], folder: group } })
        } else if (isFavoritesDrag) {
            linksUpdate({ moveFavorites: ids })
        } else {
            linksUpdate({ moveLinks: ids })
        }

        setTimeout(() => {
            const containers = document.querySelectorAll<HTMLElement>(
                '#linkblocks .in-drag, #linkblocks .dragging, #linkblocks .dropping',
            )
            for (const container of containers) {
                for (const el of container.querySelectorAll('li, button')) el.removeAttribute('style')
                container?.removeAttribute('style')
                container?.classList.remove('in-drag', 'dragging', 'dropping')
            }
            dragLayer?.remove()
            dragLayer = undefined
        }, 1)
    }, updateDelay)
}

function createDragClone(element: HTMLElement, { w, h }: Coords): HTMLElement {
    const clone = element.cloneNode(true) as HTMLElement
    clone.removeAttribute('id')
    clone.style.width = `${Math.ceil(w)}px`
    clone.style.height = `${Math.ceil(h)}px`
    return clone
}

function deplaceBlock(id: string, coord: Coords): void {
    const block = blocks.get(id)
    if (!block) return
    if (layeredIds.has(id)) {
        deplaceElem(block, coord.x, coord.y)
        return
    }
    const origin = originRects.get(id) ?? { x: 0, y: 0, w: 0, h: 0 }
    deplaceElem(block, coord.x - origin.x, coord.y - origin.y)
}

function deplaceElem(dom?: HTMLElement, x = 0, y = 0): void {
    if (dom) dom.style.transform = `translate3d(${x}px, ${y}px, 0)`
}

function deplaceDraggedElem(): void {
    const block = blocks.get(draggedId)
    if (block) {
        deplaceBlock(draggedId, { x: dx, y: dy, w: 0, h: 0 })
        dragAnimationFrame = globalThis.requestAnimationFrame(deplaceDraggedElem)
    }
}

function isDraggingOver({ x, y }: { x: number; y: number }): [DropArea, string, DropType] | undefined {
    const miniPaddingY = draggedId.startsWith('links') && !isFavoritesDrag ? MINI_HOVER_PADDING_Y : 0
    const la = findDropzoneArea(dropzones.link, linkDropDirection, x, y)

    if (isFavoritesDrag) {
        const slot = findCurrentSlotArea(linkDropDirection, x, y)
        const hit = la ?? slot

        if (hit) return [hit.area, hit.id, 'link']
    }

    const ma = findDropzoneArea(dropzones.mini, 'horizontal', x, y, miniPaddingY)
    if (ma && draggedId.startsWith('links')) return [ma.area, ma.id, 'mini']
    if (la) return [la.area, la.id, 'link']
    if (ma) return [ma.area, ma.id, 'mini']

    const slot = findCurrentSlotArea(!draggedId.startsWith('links') ? 'horizontal' : linkDropDirection, x, y)
    if (slot) return [slot.area, slot.id, !draggedId.startsWith('links') ? 'mini' : 'link']

    const miniSlot = draggedId.startsWith('links')
        ? findDropzoneSlotArea(dropzones.mini, 'horizontal', x, y, miniPaddingY)
        : undefined
    if (miniSlot) return [miniSlot.area, miniSlot.id, 'mini']

    const ga = findDropzoneArea(dropzones.group, 'center', x, y)
    if (ga) return [ga.area, ga.id, 'group']
}

function findDropzoneArea(
    zones: Dropzones,
    dir: 'horizontal' | 'vertical' | 'center',
    x: number,
    y: number,
    paddingY = 0,
): DropzoneHit | undefined {
    for (const [id, z] of zones) {
        if (!(x >= z.x && x <= z.x + z.w && y >= z.y - paddingY && y <= z.y + z.h + paddingY)) continue
        let area: DropArea = ''
        if (dir === 'center') area = 'center'
        if (dir === 'horizontal') {
            area = x < z.x + z.w * DROP_EDGE_RATIO ? 'left' : x > z.x + z.w * (1 - DROP_EDGE_RATIO) ? 'right' : 'center'
        }
        if (dir === 'vertical') {
            area = y < z.y + z.h * DROP_EDGE_RATIO ? 'left' : y > z.y + z.h * (1 - DROP_EDGE_RATIO) ? 'right' : 'center'
        }
        return { area, id }
    }
}

function findCurrentSlotArea(dir: LinkDropDirection, x: number, y: number): DropzoneHit | undefined {
    const zones = new Map<string, Coords>()

    for (let i = 0; i < ids.length; i++) {
        const coord = coords[i] ?? originRects.get(ids[i])

        if (coord) zones.set(ids[i], coord)
    }

    return findDropzoneSlotArea(zones, dir, x, y)
}

function findDropzoneSlotArea(
    zones: Dropzones,
    dir: LinkDropDirection,
    x: number,
    y: number,
    paddingY = 0,
): DropzoneHit | undefined {
    const entries = [...zones]
        .filter(([, z]) => z.w > 0 && z.h > 0)
        .map(([id, z]) => ({ id, z }))

    if (entries.length === 0) return

    const minX = Math.min(...entries.map(({ z }) => z.x))
    const maxX = Math.max(...entries.map(({ z }) => z.x + z.w))
    const minY = Math.min(...entries.map(({ z }) => z.y))
    const maxY = Math.max(...entries.map(({ z }) => z.y + z.h))
    const inHorizontalBounds = x >= minX - SLOT_MAIN_AXIS_PADDING && x <= maxX + SLOT_MAIN_AXIS_PADDING &&
        y >= minY - SLOT_CROSS_AXIS_PADDING - paddingY && y <= maxY + SLOT_CROSS_AXIS_PADDING + paddingY
    const inVerticalBounds = x >= minX - SLOT_CROSS_AXIS_PADDING && x <= maxX + SLOT_CROSS_AXIS_PADDING &&
        y >= minY - SLOT_MAIN_AXIS_PADDING - paddingY && y <= maxY + SLOT_MAIN_AXIS_PADDING + paddingY

    if ((dir === 'horizontal' && !inHorizontalBounds) || (dir === 'vertical' && !inVerticalBounds)) return

    let nearest = entries[0]
    let nearestDistance = Number.POSITIVE_INFINITY

    for (const entry of entries) {
        const center = dir === 'horizontal' ? entry.z.x + entry.z.w / 2 : entry.z.y + entry.z.h / 2
        const distance = Math.abs((dir === 'horizontal' ? x : y) - center)

        if (distance < nearestDistance) {
            nearest = entry
            nearestDistance = distance
        }
    }

    const center = dir === 'horizontal' ? nearest.z.x + nearest.z.w / 2 : nearest.z.y + nearest.z.h / 2
    const area = (dir === 'horizontal' ? x : y) < center ? 'left' : 'right'

    return { area, id: nearest.id }
}

function getPosFromEvent(event: TouchEvent | PointerEvent): { x: number; y: number } {
    if (event.type === 'touchmove' || event.type === 'touchend' || event.type === 'touchcancel') {
        const t = (event as TouchEvent).touches[0]
        if (!t) return { x: dx + cox, y: dy + coy }
        return { x: t.clientX, y: t.clientY }
    }
    if (event.type.startsWith('pointer')) return { x: (event as PointerEvent).x, y: (event as PointerEvent).y }
    return { x: 0, y: 0 }
}

function findTypeFromElement(element?: HTMLElement): 'link' | 'mini' | 'group' {
    if (element?.classList.contains('link')) return 'link'
    if (element?.classList.contains('link-title')) return 'mini'
    if (element?.classList.contains('link-group')) return 'group'
    throw new Error('No valid type found for specified element')
}

function findIdFromElement(element?: HTMLElement, type?: 'link' | 'mini' | 'group'): string {
    const t = type ?? findTypeFromElement(element)
    if (t === 'link') return element?.id ?? ''
    return element?.dataset.group ?? ''
}

import { getLinksInGroup } from './helpers.ts'
import { openContextMenu } from '../contextmenu.ts'
import { initblocks } from './index.ts'

import { transitioner } from '../../utils/transitioner.ts'
import { tradThis } from '../../utils/translations.ts'
import { storage } from '../../storage.ts'

import type { LinkGroups, Sync } from '../../../types/sync.ts'

const domlinkblocks = document.getElementById('linkblocks') as HTMLDivElement
let positionListenerAdded = false

export function isGroupFocus(): boolean {
    return document.body.classList.contains('group-focus')
}

export function setGroupFocus(focused: boolean): void {
    document.body.classList.toggle('group-focus', focused)
}

export function initGroups(data: Sync, init?: true): void {
    if (!init) {
        for (const node of document.querySelectorAll('#link-mini button') ?? []) {
            node.remove()
        }
    }

    createGroups(data.linkgroups)
    updateSelectedGroupPosition()

    if (!positionListenerAdded) {
        positionListenerAdded = true
        globalThis.addEventListener('resize', updateSelectedGroupPosition)
    }

    // navigating through groups with scroll wheel
    document.querySelector('#link-mini')?.addEventListener('wheel', (event) => {
        // Only switch groups when hovering over group buttons, not when scrolling inside a group list
        const target = event.target as HTMLElement
        const isOverGroupList = target.closest('.link-list') !== null
        const isOverLink = target.closest('.link') !== null

        if (isOverGroupList || isOverLink) {
            return // Let the scroll event propagate normally for inner content scrolling
        }

        changeGroup(event)
        event.preventDefault()
    }, { passive: false })
}

function createGroups(linkgroups: LinkGroups): void {
    const { groups, pinned, synced, selected } = linkgroups

    for (const group of [...groups, '+']) {
        const button = document.createElement('button')
        const isTopSite = group === 'topsites'
        const isDefault = group === 'default'
        const isAddMore = group === '+'

        if (pinned.includes(group)) {
            continue
        }

        button.textContent = group
        button.dataset.group = group
        button.classList.add('link-title')
        button.classList.toggle('selected-group', group === selected)
        button.classList.toggle('synced', synced.includes(group))

        if (isTopSite) {
            button.textContent = tradThis('Most visited')
            button.classList.add('topsites-title')
        }

        if (isDefault) {
            button.textContent = tradThis('Default group')
        }

        if (isAddMore) {
            button.classList.add('add-group')
            button.addEventListener('click', openContextMenu)
        } else {
            button.addEventListener('click', changeGroup)
        }

        document.querySelector('#link-mini div')?.appendChild(button)
    }

    domlinkblocks?.classList.toggle('with-groups', linkgroups.on)

    if (!linkgroups.on) {
        setGroupFocus(false)
    }
}

function changeGroup(event: Event): void {
    let button: HTMLButtonElement

    if (event.type === 'wheel') {
        // all the selectable group buttons
        const buttons = Array.from(
            document.querySelectorAll<HTMLButtonElement>('.link-title:not(.add-group)[data-group]'),
        )

        // gets the index of the currently selected group
        const index = buttons.findIndex((btn) => btn.classList.contains('selected-group'))

        button = buttons[
            // unsmooth brain thing to get the index for the previous/next button
            (index + ((event as WheelEvent).deltaY > 0 ? 1 : -1) + buttons.length) % buttons.length
        ]
    } else { // click event (probably)
        button = event.currentTarget as HTMLButtonElement
    }

    const transition = transitioner()

    if (domlinkblocks.dataset.folderid) {
        return
    }

    if (button.classList.contains('selected-group')) {
        if (event.type !== 'wheel') {
            setGroupFocus(!isGroupFocus())
            updateSelectedGroupPosition()
        }
        return
    }

    transition.first(hideCurrentGroup)
    transition.after(recreateLinksFromNewGroup)
    transition.finally(showNewGroup)
    transition.transition(100)

    async function recreateLinksFromNewGroup(): Promise<void> {
        const buttons = document.querySelectorAll<HTMLElement>('#link-mini button')
        const data = await storage.sync.get()
        const group = button.dataset.group ?? data.linkgroups.groups[0]

        for (const div of buttons ?? []) {
            div.classList.remove('selected-group')
        }
        button.classList.add('selected-group')
        data.linkgroups.selected = group
        storage.sync.set(data)
        initblocks(data)
    }

    function hideCurrentGroup(): void {
        domlinkblocks.classList.remove('in-folder')
        domlinkblocks.classList.add('hiding')
    }

    function showNewGroup(): void {
        domlinkblocks.classList.remove('hiding')
        setGroupFocus(true)
        updateSelectedGroupPosition()
    }
}

export function updateSelectedGroupPosition(): void {
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

// Updates

export function toggleGroups(on: boolean, data: Sync): Sync {
    domlinkblocks?.classList.toggle('with-groups', on)
    setGroupFocus(false)
    data.linkgroups.on = on
    return data
}

export function changeGroupTitle(title: { old: string; new: string }, data: Sync): Sync {
    const index = data.linkgroups.groups.indexOf(title.old)

    for (const link of getLinksInGroup(data, title.old)) {
        data[link._id] = {
            ...link,
            parent: title.new,
        }
    }

    data.linkgroups.groups[index] = title.new
    data.linkgroups.selected = title.new
    initGroups(data)
    return data
}

export function addGroup(groups: { title: string; sync?: boolean }[], data: Sync): Sync {
    for (const { title, sync } of groups) {
        const isReserved = title === 'default' || title === '+'
        const isAlreadyUsed = data.linkgroups.groups.includes(title)

        if (isReserved || isAlreadyUsed) {
            continue
        }

        for (const link of getLinksInGroup(data, '+')) {
            data[link._id] = {
                ...link,
                parent: title,
            }
        }

        data.linkgroups.selected = title
        data.linkgroups.groups.push(title)

        if (sync) {
            data.linkgroups.synced.push(title)
        }
    }

    // Remove empty "default" group when other groups exist with actual links
    const defaultHasLinks = getLinksInGroup(data, 'default').length > 0
    const hasOtherGroups = data.linkgroups.groups.some((g) => g !== 'default')

    if (!defaultHasLinks && hasOtherGroups) {
        data.linkgroups.groups = data.linkgroups.groups.filter((g) => g !== 'default')
        data.linkgroups.pinned = data.linkgroups.pinned.filter((g) => g !== 'default')
        data.linkgroups.synced = data.linkgroups.synced.filter((g) => g !== 'default')

        if (data.linkgroups.selected === 'default') {
            data.linkgroups.selected = data.linkgroups.groups[0]
        }
    }

    initGroups(data)
    initblocks(data)
    return data
}

export function deleteGroup(group: string, data: Sync): Sync {
    const { groups, pinned, synced, selected } = data.linkgroups

    const isBroken = groups.indexOf(group) === -1
    const isMinimum = groups.length === 1

    if (isMinimum || isBroken) {
        return data
    }

    for (const link of getLinksInGroup(data, group)) {
        delete data[link._id]
    }

    data.linkgroups.selected = group === selected || pinned.includes(group) ? groups[0] : selected
    data.linkgroups.pinned = pinned.filter((p) => p !== group)
    data.linkgroups.synced = synced.filter((g) => g !== group)
    data.linkgroups.groups = groups.filter((g) => g !== group)
    delete data.linkgroups.hidden[group]

    if (groups.length === 2) {
        data.linkgroups.pinned = []
    }

    storage.sync.clear()
    initblocks(data)
    initGroups(data)
    return data
}

export function moveGroups(mini: string[], data: Sync): Sync {
    const userMini = mini.filter((name) => name !== '+')

    data.linkgroups.groups = data.linkgroups.pinned.concat(userMini)
    initGroups(data)

    return data
}

export async function togglePinGroup(group: string, action: 'pin' | 'unpin'): Promise<void> {
    const data = await storage.sync.get()
    const { groups, pinned } = data.linkgroups

    if (action === 'pin') {
        data.linkgroups.pinned.push(group)
    }
    if (action === 'unpin') {
        data.linkgroups.pinned = pinned.filter((pinned) => pinned !== group)
    }

    if (group === data.linkgroups.selected) {
        const unpinned = groups.filter((id) => pinned.includes(id) === false)
        data.linkgroups.selected = unpinned[0]
    }

    storage.sync.set(data)

    initblocks(data)
    initGroups(data)
}

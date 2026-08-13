import { IS_MOBILE, SYSTEM_OS } from '../defaults.ts'
import { transitioner } from '../utils/transitioner.ts'
import { debounce } from '../utils/debounce.ts'
import { requestHostPermission } from '../utils/permissions.ts'
import { initCustomSelects } from '../shared/custom-select.ts'
import { onclickdown } from '../utils/clickdown.ts'
import { backgroundUpdate } from './backgrounds/index.ts'
import { safeUnsplashDownloadLocation } from './backgrounds/credits.ts'
import { trackUnsplashDownload } from './backgrounds/unsplash.ts'
import { storage } from '../storage.ts'

import type { Backgrounds } from '../../types/sync.ts'

interface EventLocation {
    widgets: {
        link: boolean
        time: boolean
    }
    interface: boolean
}

interface Section {
    section: string
    scrollto: string
}

const sectionMatching: Record<string, Section> = {
    time: {
        section: '#time',
        scrollto: 'time_title',
    },
}
const UNSPLASH_ASSET_ORIGINS = new Set([
    'https://images.unsplash.com',
    'https://image.unsplash.com',
    'https://plus.unsplash.com',
])

const mainInterface = document.getElementById('interface') as HTMLDivElement
const domdialog = document.getElementById('contextmenu') as HTMLDialogElement

let eventLocation: EventLocation

export function openContextMenu(event: Event): void {
    const selection = globalThis.getSelection() // imperfect selected text detection to allow for OS context menu

    if (selection && !selection.isCollapsed) {
        return
    }

    const target = getContextTarget(event)

    if (target.closest('#linkblocks')) {
        event.preventDefault()
        closeContextMenu()
        return
    }

    eventLocation = {
        widgets: {
            link: !!target.closest('#linkblocks'),
            time: !!target.closest(sectionMatching.time.section),
        },
        interface: target.matches('main#interface'),
    }

    const pointer = event as PointerEvent
    const ctrlRightClick = pointer.button === 2 && !!pointer.ctrlKey && event.type === 'contextmenu'
    const notPressingE = event.type === 'keyup' && (event as KeyboardEvent).code !== 'KeyE'

    const clickedOnWidgets = Object.values(eventLocation.widgets).some((v) => v)
    const menuWillOpen = !(ctrlRightClick || notPressingE) && (clickedOnWidgets || eventLocation.interface)

    if (!menuWillOpen) {
        return
    }

    // hides/resets content from previous context menu
    for (const node of domdialog.querySelectorAll('label, button, hr, #background-actions, input')) {
        node.classList.remove('on')

        if (node instanceof HTMLInputElement) {
            node.required = false
        }
    }

    // prevents OS context menu
    event.preventDefault()

    // Must be placed after "li?.classList.add('selected')"
    // eventLocation.selected = getSelectedIds()

    const contextmenuTransition = transitioner()
    contextmenuTransition.first(() => domdialog?.show())
    contextmenuTransition.after(() => domdialog?.classList?.add('shown'))
    void contextmenuTransition.transition(10).catch((err) => console.warn('Cannot open context menu', err))

    if (clickedOnWidgets) {
        const allWidgets = Object.entries(eventLocation.widgets)
        const clickedOnWidgets = allWidgets.filter(([_, clicked]) => clicked)

        for (const [widget] of clickedOnWidgets) {
            const section = sectionMatching[widget]
            populateDialogWithAction('openTheseSettings', section.scrollto)
        }

        if (!hasVisibleContent()) {
            closeContextMenu()
            return
        }

        positionContextMenu(event)
        return
    }

    if (eventLocation.interface) {
        showTheseElements('#background-actions')

        if (!hasVisibleContent()) {
            closeContextMenu()
            return
        }

        positionContextMenu(event)
    }
}

function getContextTarget(event: Event): HTMLElement {
    const originalTarget = event.target as HTMLElement

    if (originalTarget && originalTarget !== mainInterface) {
        return originalTarget
    }

    if (document.body.classList.contains('group-focus') && event.type === 'contextmenu') {
        const activeGroup = document.querySelector<HTMLElement>('#linkblocks > .link-group')
        const pointer = event as PointerEvent

        if (activeGroup) {
            const rect = activeGroup.getBoundingClientRect()
            const insideGroup = pointer.clientX >= rect.left && pointer.clientX <= rect.right &&
                pointer.clientY >= rect.top && pointer.clientY <= rect.bottom

            if (insideGroup) {
                return activeGroup.querySelector<HTMLElement>('.link-list') ?? activeGroup
            }
        }
    }

    return originalTarget
}

function populateDialogWithAction(actionType: string, attribute?: string): void {
    let selector = `[data-action="${actionType}"]`

    if (attribute) {
        selector += `[data-attribute="${attribute}"]`
    }

    showTheseElements(selector)
}

export function positionContextMenu(event: Event): void {
    const editRects = domdialog.getBoundingClientRect()
    const withPointer = event.type === 'contextmenu' || event.type === 'click' || event.type === 'touchstart'
    const withKeyboard = event.type === 'keyup' && (event as KeyboardEvent)?.key === 'e'
    const { innerHeight, innerWidth } = window
    const isMobileSized = innerWidth < 600
    const docLang = document.documentElement.lang
    const rightToLeft = docLang === 'ar' || docLang === 'fa' || docLang === 'he'

    let x = 0
    let y = 0

    if (withPointer && isMobileSized) {
        x = (innerWidth - editRects.width) / 2
        y = (event.type === 'touchstart' ? (event as TouchEvent).touches[0].clientY : (event as PointerEvent).y) -
            60 -
            editRects.height
    } //
    else if (withPointer) {
        // gets coordinates differently from touchstart or contextmenu
        x = event.type === 'touchstart' ? (event as TouchEvent).touches[0].clientX : (event as PointerEvent).x
        y = event.type === 'touchstart' ? (event as TouchEvent).touches[0].clientY : (event as PointerEvent).y
    } //
    else if (withKeyboard) {
        const targetEl = event.target as HTMLElement
        const rect = targetEl.getBoundingClientRect()

        x = rect.right
        y = rect.bottom + 4
    }

    const w = editRects.width
    const h = editRects.height

    if (x + w > innerWidth) {
        x -= x + w - innerWidth
    }

    if (y + h > innerHeight) {
        y -= h
    }

    if (rightToLeft) {
        x *= -1
    }

    domdialog.style.transform = `translate(${Math.floor(x)}px, ${Math.floor(y)}px)`
}

export function openSettingsButtonEvent(event: Event): void {
    const target = event.target as HTMLButtonElement
    const sectionToScrollTo = target.getAttribute('data-attribute')

    if (sectionToScrollTo) {
        document.dispatchEvent(
            new CustomEvent('toggle-settings', {
                detail: { scrollTo: `#${sectionToScrollTo}` },
            }),
        )

        closeContextMenu()
    } else {
        console.error(`Section "${sectionToScrollTo}" doesn't match anything`)
    }
}

function showTheseElements(query: string): void {
    document.querySelectorAll<HTMLElement>(query).forEach((element) => {
        element.classList.add('on')
    })
}

function hasVisibleContent(): boolean {
    const visible = domdialog.querySelectorAll<HTMLElement>('label.on, button.on, hr.on, #background-actions.on')

    return Array.from(visible).some((element) => element.getClientRects().length > 0)
}

queueMicrotask(() => {
    initCustomSelects(domdialog)

    document.addEventListener('contextmenu', (event) => {
        if (event.altKey) { // if alt + right click, then regular OS context menu
            closeContextMenu()
            return
        }

        // if right click inside interface, custom context menu
        if (mainInterface?.contains(event.target as Node)) {
            openContextMenu(event)
            return
        }

        // Otherwise, closes the custom one and opens the regular one
        closeContextMenu()
    })

    // closes context menu when moving to other tab/window
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            closeContextMenu()
        }
    })

    // Update spans next to file inputs on value change
    domdialog.querySelectorAll<HTMLInputElement>('input[type="file"]')?.forEach((input) => {
        input.addEventListener('change', function (this): void {
            const span = this.nextElementSibling
            const isSpan = span?.tagName === 'SPAN'
            const file = this.files?.[0]

            if (span && file && isSpan) {
                span.textContent = file.name
            }
        })
    })

    // for when needing to close context menu from elsewhere
    document.addEventListener('close-edit', closeContextMenu)

    // these are "open x settings" inside context menu
    const openSettingsButtons = domdialog.querySelectorAll<HTMLButtonElement>(`[data-action="openTheseSettings"]`)
    openSettingsButtons?.forEach((btn) => {
        btn?.addEventListener('click', openSettingsButtonEvent)
    })

    if (SYSTEM_OS === 'ios' || !IS_MOBILE) {
        const handleLongPress = debounce((event: TouchEvent) => {
            openContextMenu(event)
        }, 500)

        document?.addEventListener('touchstart', (event) => {
            const touchY = event.touches[0].clientY
            const windowHeight = globalThis.innerHeight

            const threshold = windowHeight * 0.95

            // only continues with the long press if the user has started the swipe in the top 95% of the window height
            // otherwise it would trigger the context menu when switching apps on iPad
            if (touchY < threshold) {
                handleLongPress(event)
            }
        })

        document?.addEventListener('touchend', () => {
            handleLongPress.cancel()
        })

        globalThis.addEventListener('resize', closeContextMenu)
    }
})

export function closeContextMenu(): void {
    if (domdialog.open) {
        const selected = document.querySelectorAll('.link-title.selected, .link.selected')

        for (const node of selected) {
            node?.classList.remove('selected')
        }

        domdialog.removeAttribute('data-tab')
        domdialog.classList.remove('shown')
        domdialog.close()
    }
}

export function handleBackgroundActions(backgrounds: Backgrounds): void {
    const type = backgrounds.type
    const freq = backgrounds.frequency
    const downloadButton = document.getElementById('b_interface-background-download')

    document.getElementById('background-actions')?.setAttribute('data-type', type)
    document.getElementById('b_interface-background-pause')?.classList.toggle('paused', freq === 'pause')
    if (type !== 'images') {
        downloadButton?.setAttribute('disabled', '')
    }
}

export function initBackgroundActionsEvents(): void {
    onclickdown(document.getElementById('b_interface-background-pause'), () => {
        void toggleBackgroundPause().catch((err) => console.warn('Background pause failed', err))
    })

    onclickdown(document.getElementById('b_interface-background-refresh'), (event) => {
        void backgroundUpdate({ refresh: event }).catch((err) => console.warn('Background refresh failed', err))
    })

    onclickdown(document.getElementById('b_interface-background-download'), () => {
        void downloadImage().catch((err) => console.warn('Background download failed', err))
    })
}

async function toggleBackgroundPause(): Promise<void> {
    const freqInput = document.querySelector<HTMLSelectElement>('#i_freq')
    const button = document.getElementById('b_interface-background-pause')
    const paused = button?.classList.contains('paused')
    const sync = await storage.sync.get('backgrounds')
    const last = localStorage.lastBackgroundFreq || 'hour'

    if (freqInput) {
        freqInput.value = paused ? last : 'pause'
    }

    if (paused) {
        await backgroundUpdate({ freq: last })
    } else {
        localStorage.lastBackgroundFreq = sync.backgrounds.frequency
        await backgroundUpdate({ freq: 'pause' })
    }
}

async function downloadImage(): Promise<void> {
    const dombutton = document.querySelector<HTMLButtonElement>('#b_interface-background-download')
    const domsave = document.querySelector<HTMLAnchorElement>('#download-background')

    if (dombutton?.classList.contains('loading')) return
    if (!domsave) {
        console.warn('Download link is missing')
        return
    }

    dombutton?.classList.replace('idle', 'loading')

    let objectUrl = ''

    try {
        const downloadLocation = safeUnsplashDownloadLocation(domsave.dataset.downloadLocation)
        if (!downloadLocation) {
            throw new Error('Background download endpoint is not an Unsplash API download location')
        }

        const local = await storage.local.get('unsplashAccessKey')
        const accessKey = local.unsplashAccessKey?.trim()
        if (!accessKey) {
            throw new Error('An Unsplash Access Key is required to download this background')
        }

        const trackedUrl = await trackUnsplashDownload(downloadLocation, accessKey)
        const imageUrl = safeUnsplashAssetUrl(trackedUrl)
        if (!imageUrl) {
            throw new Error('Unsplash returned an unexpected image URL')
        }

        if (!await requestHostPermission(imageUrl)) {
            throw new Error('Permission to download from this image host was not granted')
        }

        const imageResponse = await fetch(imageUrl, {
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
        })

        if (!imageResponse.ok) {
            throw new Error(`Image download returned ${imageResponse.status}`)
        }

        const blob = await imageResponse.blob()
        if (!blob.type.startsWith('image/')) {
            throw new Error('Unsplash returned an unexpected download type')
        }

        objectUrl = URL.createObjectURL(blob)
        domsave.href = objectUrl
        domsave.download = new URL(downloadLocation).pathname.split('/')[2]
        domsave.click()
    } finally {
        dombutton?.classList.replace('loading', 'idle')

        if (objectUrl) {
            setTimeout(() => {
                URL.revokeObjectURL(objectUrl)
                domsave.removeAttribute('href')
            }, 1000)
        }
    }
}

export function safeUnsplashAssetUrl(value: string): URL | undefined {
    try {
        const url = new URL(value)

        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.hash ||
            !UNSPLASH_ASSET_ORIGINS.has(url.origin)
        ) {
            return
        }

        return url
    } catch (_) {
        return
    }
}

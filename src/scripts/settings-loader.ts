import { storage } from './storage.ts'
import { flushPendingDebounces } from './utils/debounce.ts'

import type { Local } from '../types/local.ts'
import type { Sync } from '../types/sync.ts'

interface PendingToggle {
    detail?: unknown
}

let loadPromise: Promise<void> | undefined
let settingsLoaded = false
let latestSync: Sync
let fallbackLocal: Local
let pendingToggle: PendingToggle | undefined

export function settingsLoader(sync: Sync, local: Local): void {
    latestSync = sync
    fallbackLocal = local

    const showSettings = document.getElementById('show-settings')
    const contextButtons = document.body.querySelectorAll<HTMLButtonElement>('[data-action="openTheseSettings"]')

    document.addEventListener('updateSettingsBeforeInit', updatePendingSync)
    document.addEventListener('toggle-settings', queueToggleBeforeLoad)
    showSettings?.addEventListener('pointerdown', preloadFromUserEvent)
    contextButtons.forEach((button) => button.addEventListener('pointerdown', preloadFromUserEvent))

    function cleanupPreloadListeners(): void {
        document.removeEventListener('updateSettingsBeforeInit', updatePendingSync)
        document.removeEventListener('toggle-settings', queueToggleBeforeLoad)
        showSettings?.removeEventListener('pointerdown', preloadFromUserEvent)
        contextButtons.forEach((button) => button.removeEventListener('pointerdown', preloadFromUserEvent))
    }

    async function load(): Promise<void> {
        await Promise.all([loadSettingsMarkup(), loadSettingsStyles()])
        await flushPendingDebounces().catch((err) => {
            console.warn('Cannot flush pending settings before loading the panel', err)
        })
        await storage.flushWrites().catch((err) => {
            console.warn('Cannot finish pending settings writes before loading the panel', err)
        })

        const [{ settingsInit }, currentSync, currentLocal] = await Promise.all([
            import('./settings.ts'),
            storage.sync.get().catch((err) => {
                console.warn('Cannot refresh settings before loading the panel', err)
                return latestSync
            }),
            storage.local.get().catch((err) => {
                console.warn('Cannot refresh local state before loading settings', err)
                return fallbackLocal
            }),
        ])

        settingsInit(currentSync, currentLocal)
        settingsLoaded = true
        cleanupPreloadListeners()

        if (pendingToggle) {
            const queued = pendingToggle
            pendingToggle = undefined
            document.dispatchEvent(new CustomEvent('toggle-settings', { detail: queued.detail }))
        }
    }

    function ensureLoaded(): Promise<void> {
        if (settingsLoaded) return Promise.resolve()
        if (!loadPromise) {
            loadPromise = load().catch((err) => {
                loadPromise = undefined
                console.warn('Settings could not be loaded', err)
                throw err
            })
        }
        return loadPromise
    }

    function preloadFromUserEvent(event: Event): void {
        const isLeftPointer = event.type === 'pointerdown' && (event as PointerEvent).button === 0
        if (isLeftPointer) {
            void ensureLoaded().catch(() => {})
        }
    }

    function queueToggleBeforeLoad(event: Event): void {
        if (settingsLoaded) return

        event.stopImmediatePropagation()
        pendingToggle = { detail: (event as CustomEvent).detail }
        void ensureLoaded().catch(() => {})
    }

    function updatePendingSync(event: Event): void {
        latestSync = (event as CustomEvent<Sync>).detail
    }
}

async function loadSettingsMarkup(): Promise<void> {
    const container = document.getElementById('settings')
    if (!container || container.childElementCount > 0) return

    const source = container.dataset.contentSrc ?? 'settings.html'
    const response = await fetch(source, { cache: 'no-cache', credentials: 'same-origin' })
    if (!response.ok) {
        throw new Error(`Settings markup returned ${response.status}`)
    }

    const html = await response.text()
    if (!html.includes('id="mobile-drag-zone"') || !html.includes('id="settings-footer"')) {
        throw new Error('Settings markup is incomplete')
    }

    const template = document.createElement('template')
    template.innerHTML = html
    container.replaceChildren(template.content.cloneNode(true))
}

async function loadSettingsStyles(): Promise<void> {
    const link = document.querySelector<HTMLLinkElement>('#settings-styles')
    if (!link || link.sheet) return

    const source = link.dataset.href
    if (!source) throw new Error('Settings stylesheet path is missing')

    await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
            link.removeEventListener('load', onLoad)
            link.removeEventListener('error', onError)
        }
        const onLoad = (): void => {
            cleanup()
            resolve()
        }
        const onError = (): void => {
            cleanup()
            link.removeAttribute('href')
            reject(new Error('Settings stylesheet failed to load'))
        }

        link.addEventListener('load', onLoad)
        link.addEventListener('error', onError)
        link.href = source
    })
}

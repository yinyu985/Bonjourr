import { IS_MOBILE } from '../defaults.ts'
import { backgroundsInit } from '../features/backgrounds/index.ts'
import { needsChange } from '../shared/time.ts'
import { storage } from '../storage.ts'
import { clock } from '../features/clock/index.ts'

export function onlineAndMobile(): void {
    let visibilityHasChanged = false

    // PWA support was retired. Explicitly unregister older installations and
    // remove their version caches; deleting the registration source alone
    // would leave an already-installed worker controlling returning users.
    void removeLegacyPwa().catch((err) => {
        console.warn('Legacy PWA cleanup failed', err)
    })

    if (IS_MOBILE) {
        document.addEventListener('visibilitychange', () => {
            void updateOnVisibilityChange().catch((err) => console.warn('Mobile resume update failed', err))
        })
    }

    async function updateOnVisibilityChange(): Promise<void> {
        if (visibilityHasChanged === false) {
            visibilityHasChanged = true
            return
        }

        visibilityHasChanged = false

        const sync = await storage.sync.get()
        const local = await storage.local.get()
        const { backgroundLastChange } = local

        if (!sync.clock) {
            return
        }

        const time = (backgroundLastChange ? new Date(backgroundLastChange) : new Date()).getTime()
        const needNew = needsChange(sync.backgrounds.frequency, time)
        const notColor = sync.backgrounds.type !== 'color'

        clock(sync)

        if (notColor && needNew) {
            backgroundsInit(sync, local)
        }
    }
}

async function removeLegacyPwa(): Promise<void> {
    if ('serviceWorker' in navigator) {
        const expectedScope = new URL('./', globalThis.location.href).href
        const registrations = await navigator.serviceWorker.getRegistrations()
        await Promise.all(
            registrations.filter((registration) => {
                const worker = registration.active ?? registration.waiting ?? registration.installing
                if (registration.scope !== expectedScope || !worker) return false
                return new URL(worker.scriptURL).pathname.endsWith('/service-worker.js')
            }).map((registration) => registration.unregister()),
        )
    }

    if ('caches' in globalThis) {
        const keys = await caches.keys()
        const legacyVersionCache = /^v?\d+\.\d+\.\d+(?:[-+].+)?$/
        await Promise.all(
            keys.filter((key) => legacyVersionCache.test(key)).map(async (key) => {
                if (await isBonjourrCache(key)) await caches.delete(key)
            }),
        )
    }
}

async function isBonjourrCache(key: string): Promise<boolean> {
    const cache = await caches.open(key)
    const candidates = [
        new URL('./', globalThis.location.href).href,
        new URL('./index.html', globalThis.location.href).href,
    ]

    for (const url of candidates) {
        const response = await cache.match(url)
        if (!response) continue
        const html = await response.clone().text()
        if (html.includes('id="background-wrapper"') && html.includes('id="linkblocks"')) return true
    }

    return false
}

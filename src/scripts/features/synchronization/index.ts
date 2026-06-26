import { getRemoteProvider } from './provider.ts'
import { isDistantUrlValid, receiveFromURL } from './url.ts'
import { resetBackgroundRuntimeCache } from '../backgrounds/cache.ts'
import { bootstrapBookmarksFromConfig, holdBookmarkRefreshes, replaceBookmarksFromConfig } from '../links/bookmarks.ts'
import { onSettingsLoad } from '../../utils/onsettingsload.ts'
import { mergeImportedConfig } from '../../compatibility/apply.ts'
import { stableStringify } from '../../utils/stringify.ts'
import { tradThis } from '../../utils/translations.ts'
import { fadeOut } from '../../shared/dom.ts'
import { networkForm } from '../../shared/form.ts'
import { SYNC_DEFAULT } from '../../defaults.ts'
import { storage } from '../../storage.ts'

import type { Local, SyncType } from '../../../types/local.ts'
import type { Sync } from '../../../types/sync.ts'

interface SyncUpdate {
    type?: string
    url?: string
    gistToken?: string
    firefoxPersist?: boolean
    down?: true
    up?: true
}

const gistsyncform = networkForm('f_gistsync')
const urlsyncform = networkForm('f_urlsync')

let syncLocked = false
let autoUploadTimer = 0
let lastSyncedPayload = ''
let confirmRemoteOverwrite = false
// scheduleAutoUpload skips when syncLocked is true (we're mid-upload/-download
// and don't want to fight ourselves). But edits during an upload still need
// to propagate. We set this flag whenever a sync write is dropped because of
// the lock; the lock-holder re-schedules an upload on its way out so the
// debounce timer always exists when there's queued work.
let pendingUpload = false
const AUTO_UPLOAD_DEBOUNCE_MS = 30000
// 启动期间每开一个新标签页都会调一次 autoSyncOnStartup 拉远端。
// 频繁开标签页 = 短时间内打几十次 provider API。同一会话 60s 内只查一次远端。
const STARTUP_FETCH_THROTTLE_MS = 60_000

export function synchronization(init?: Local, update?: SyncUpdate): void {
    if (init) {
        // Legacy: 'browser' was a Chrome/Firefox-Sync option that never did
        // anything (storage.ts uses chrome.storage.local even for the 'sync'
        // namespace). The option is gone — fold any old value into 'off' so
        // the UI matches storage instead of falling through every switch.
        if ((init.syncType as string) === 'browser') {
            init.syncType = 'off'
            storage.local.set({ syncType: 'off' })
        }

        onSettingsLoad(() => {
            toggleSyncSettingsOption(init)
            setTimeout(() => handleStoragePersistence(init.syncType), 200)
        })

        autoSyncOnStartup(init)
        globalThis.addEventListener('bonjourr-sync-write', scheduleAutoUpload)
    }

    if (update) {
        updateSyncOption(update)
    }
}

async function autoSyncOnStartup(local: Local): Promise<void> {
    const provider = getRemoteProvider(local)

    if (!provider?.isEnabled(local)) {
        return
    }

    if (!provider.isAuthorized(local) || !provider.getResourceId(local)) {
        return
    }

    // 节流：60s 内已经查过远端就不再请求，直接信任本地 hash。
    // 否则每开一个新标签页都请求 provider 一次，几秒钟开几个标签 = 暴打 API。
    const lastFetchedAt = provider.getLastFetchedAt(local)
        ? new Date(provider.getLastFetchedAt(local) ?? '').getTime()
        : 0
    const fetchedRecently = lastFetchedAt && Date.now() - lastFetchedAt < STARTUP_FETCH_THROTTLE_MS

    if (fetchedRecently) {
        const current = await bootstrapBookmarksFromConfig(await storage.sync.get())
        lastSyncedPayload = syncPayloadHash(current)
        return
    }

    syncLocked = true

    try {
        const result = await provider.download(local)
        await storage.local.set(provider.fetchedPatch(new Date().toISOString()))

        const lastSyncedAt = provider.getLastSyncedAt(local)
        if (lastSyncedAt && !isRemoteNewer(result.metadata.updatedAt, lastSyncedAt)) {
            const current = await bootstrapBookmarksFromConfig(await storage.sync.get())
            lastSyncedPayload = syncPayloadHash(current)
            return
        }

        const data = await storage.sync.get()
        const next = await applyDownloadedSync(data, result.sync)
        lastSyncedPayload = syncPayloadHash(next)
        await storage.local.set(provider.syncedPatch(result.metadata))
        // Just downloaded fresh remote state — any writes that landed during
        // the download are reflected in `next`, so drop the pending flag.
        pendingUpload = false
        fadeOut()
    } catch (err) {
        console.warn('Auto sync on startup failed', err)
        const current = await bootstrapBookmarksFromConfig(await storage.sync.get())
        lastSyncedPayload = syncPayloadHash(current)
    } finally {
        releaseSyncLock()
    }
}

function scheduleAutoUpload(): void {
    if (syncLocked) {
        // The current sync writer (download or upload) will re-schedule us
        // when it releases the lock — see releaseSyncLock().
        pendingUpload = true
        return
    }

    storage.local.set({ localConfigUpdatedAt: new Date().toISOString() })
    confirmRemoteOverwrite = false

    if (autoUploadTimer) {
        clearTimeout(autoUploadTimer)
    }

    autoUploadTimer = setTimeout(doAutoUpload, AUTO_UPLOAD_DEBOUNCE_MS)
}

function releaseSyncLock(): void {
    syncLocked = false
    if (pendingUpload) {
        pendingUpload = false
        scheduleAutoUpload()
    }
}

async function doAutoUpload(): Promise<void> {
    autoUploadTimer = 0

    if (syncLocked) {
        pendingUpload = true
        return
    }

    const local = await storage.local.get()
    const provider = getRemoteProvider(local)

    if (!provider?.isEnabled(local) || !provider.isAuthorized(local)) {
        return
    }

    syncLocked = true

    try {
        const lastSyncedAt = provider.getLastSyncedAt(local)

        if (provider.getResourceId(local) && lastSyncedAt) {
            const remoteUpdatedAt = await provider.fetchUpdatedAt(local)
            if (remoteUpdatedAt && isRemoteNewer(remoteUpdatedAt, lastSyncedAt)) {
                pendingUpload = false
                return
            }
        }

        const latest = await bootstrapBookmarksFromConfig(await storage.sync.get())
        const payload = syncPayloadHash(latest)

        if (payload === lastSyncedPayload) {
            pendingUpload = false
            return
        }

        const result = await provider.upload(local, latest)
        lastSyncedPayload = payload
        pendingUpload = false
        storage.local.set(provider.syncedPatch(result))
    } catch (err) {
        console.warn('Auto upload failed', err)
    } finally {
        releaseSyncLock()
    }
}

async function updateSyncOption(update: SyncUpdate): Promise<void> {
    const local = await storage.local.get()
    const provider = getRemoteProvider(local)

    if (update.down) {
        if (syncLocked) {
            gistsyncform.warn(tradThis('Sync in progress, please wait.'))
            return
        }

        syncLocked = true

        try {
            const data = await storage.sync.get()

            if (provider?.isEnabled(local)) {
                gistsyncform.load()

                try {
                    const result = await provider.download(local)
                    const next = await applyDownloadedSync(data, result.sync)
                    lastSyncedPayload = syncPayloadHash(next)
                    await storage.local.set({
                        ...provider.syncedPatch(result.metadata),
                        ...provider.fetchedPatch(new Date().toISOString()),
                    })
                    pendingUpload = false
                    gistsyncform.accept()
                    fadeOut()
                } catch (err) {
                    gistsyncform.warn(err as string)
                }
            }

            if (local.syncType === 'url') {
                urlsyncform.load()

                try {
                    const incoming = await receiveFromURL(local.distantUrl)
                    await applyDownloadedSync(data, incoming)
                    urlsyncform.accept()
                    fadeOut()
                } catch (err) {
                    urlsyncform.warn(err as string)
                }
            }
        } finally {
            releaseSyncLock()
        }
    }

    if (update.up) {
        if (syncLocked) {
            gistsyncform.warn(tradThis('Sync in progress, please wait.'))
            return
        }

        if (provider?.isEnabled(local)) {
            // Hold the lock for the duration of the manual upload too —
            // otherwise auto-upload's debounced doAutoUpload could fire
            // partway through and double-send to the remote provider.
            syncLocked = true
            gistsyncform.load()

            try {
                const lastSyncedAt = provider.getLastSyncedAt(local)

                if (provider.getResourceId(local) && lastSyncedAt) {
                    const remoteUpdatedAt = await provider.fetchUpdatedAt(local)
                    if (remoteUpdatedAt && isRemoteNewer(remoteUpdatedAt, lastSyncedAt) && !confirmRemoteOverwrite) {
                        confirmRemoteOverwrite = true
                        gistsyncform.warn(
                            tradThis('Remote data is newer than local. Click send again to overwrite remote.'),
                        )
                        return
                    }
                }

                const latest = getSettingsTextAreaSync() ??
                    await bootstrapBookmarksFromConfig(await storage.sync.get())

                const result = await provider.upload(local, latest)
                lastSyncedPayload = syncPayloadHash(latest)
                pendingUpload = false
                confirmRemoteOverwrite = false

                gistsyncform.accept()

                storage.local.set(provider.syncedPatch(result))

                provider.setStatusNow(result.resourceId)
            } catch (error) {
                gistsyncform.warn(error as string)
            } finally {
                releaseSyncLock()
            }
        }
    }

    if (update.gistToken === '') {
        local.gistToken = ''
        local.remoteResourceId = ''
        local.remoteLastSyncedAt = undefined
        storage.local.remove('gistToken')
        for (const key of getRemoteProvider({ ...local, syncType: 'gist' })?.clearPatch() ?? []) {
            storage.local.remove(key)
        }
        gistsyncform.accept()
        toggleSyncSettingsOption(local)
        return
    }

    if (update.url === '') {
        local.distantUrl = ''
        storage.local.remove('distantUrl')
        toggleSyncSettingsOption(local)
        return
    }

    if (update.gistToken) {
        gistsyncform.load()

        try {
            local.gistToken = update.gistToken
            const gist = getRemoteProvider({ ...local, syncType: 'gist' })
            const foundId = await gist?.findResource(local)

            local.remoteResourceId = foundId ?? ''
            // The previous token's last-sync timestamp is meaningless against
            // a different remote resource — clear it so isRemoteNewer doesn't compare a
            // stale local time against a fresh remote time and incorrectly
            // skip the next download.
            local.remoteLastSyncedAt = undefined
            storage.local.set({
                gistToken: local.gistToken,
                remoteResourceId: local.remoteResourceId,
            })
            for (const key of gist?.clearPatch() ?? []) {
                if (key !== 'remoteResourceId') {
                    storage.local.remove(key)
                }
            }
            // Different remote resource, different content — force the next sync to
            // re-evaluate even if hashes happen to collide.
            lastSyncedPayload = ''

            gistsyncform.accept()
            toggleSyncSettingsOption(local)
        } catch (error) {
            gistsyncform.warn(error as string)
        }
    }

    if (update.url) {
        urlsyncform.load()

        try {
            await receiveFromURL(update.url)
            urlsyncform.accept('i_urlsync', update.url)

            local.distantUrl = update.url
            storage.local.set({ distantUrl: update.url })
            toggleSyncSettingsOption(local)
        } catch (error) {
            urlsyncform.warn(error as string)
        }
    }

    if (isSyncType(update.type)) {
        local.syncType = update.type
        storage.local.set({ syncType: local.syncType })

        toggleSyncSettingsOption(local)
        handleStoragePersistence(update.type)
    }

    if (update.firefoxPersist) {
        localStorage.choseStoragePersistence = 'true'
        toggleSyncSettingsOption(local)
    }
}

async function handleStoragePersistence(type?: SyncType): Promise<boolean | undefined> {
    if (!navigator?.storage?.persisted) {
        return
    }

    const persisted = await navigator.storage.persisted()

    if (type !== 'off') {
        return
    }

    if (!persisted) {
        await navigator.storage.persist()
    }
}

async function toggleSyncSettingsOption(local?: Local): Promise<void> {
    const provider = getRemoteProvider(local)
    const resourceId = local ? provider?.getResourceId(local) : undefined
    const gistToken = local?.gistToken
    const distantUrl = local?.distantUrl
    const type = local?.syncType

    const iGistsync = document.querySelector<HTMLInputElement>('#i_gistsync')
    const iUrlsync = document.querySelector<HTMLInputElement>('#i_urlsync')
    const bGistdown = document.querySelector<HTMLInputElement>('#b_gistdown')
    const bGistup = document.querySelector<HTMLInputElement>('#b_gistup')
    const bUrldown = document.querySelector<HTMLInputElement>('#b_urldown')

    bGistdown?.setAttribute('disabled', '')
    bUrldown?.setAttribute('disabled', '')
    bGistup?.setAttribute('disabled', '')

    if (iGistsync && gistToken) {
        iGistsync.value = gistToken
    }
    if (iUrlsync && distantUrl) {
        iUrlsync.value = distantUrl
    }

    const choseStoragePersistence = localStorage.choseStoragePersistence === 'true'
    document.getElementById('disabled-sync')?.classList.toggle('shown', !choseStoragePersistence)

    switch (type) {
        case 'off': {
            document.getElementById('url-sync')?.classList.remove('shown')
            document.getElementById('gist-sync')?.classList.remove('shown')
            break
        }

        case 'gist': {
            document.getElementById('gist-sync')?.classList.add('shown')
            document.getElementById('url-sync')?.classList.remove('shown')
            document.getElementById('disabled-sync')?.classList.remove('shown')

            if (!gistToken) {
                provider?.setStatus()
                break
            }

            bGistup?.removeAttribute('disabled')

            if (resourceId) {
                bGistdown?.removeAttribute('disabled')
            }

            provider?.setStatus(local)

            break
        }

        case 'url': {
            document.getElementById('url-sync')?.classList.add('shown')
            document.getElementById('gist-sync')?.classList.remove('shown')
            document.getElementById('disabled-sync')?.classList.remove('shown')

            if (distantUrl && await isDistantUrlValid(distantUrl)) {
                bUrldown?.removeAttribute('disabled')
            }

            break
        }

        default:
    }
}

// Type check

function isSyncType(val = ''): val is SyncType {
    return ['gist', 'url', 'off'].includes(val)
}

async function applyDownloadedSync(current: Sync, incoming: Partial<Sync>): Promise<Sync> {
    const next = normalizeExternalSync(incoming)

    await replaceBookmarksFromConfig(current, next)
    holdBookmarkRefreshes()
    await resetBackgroundRuntimeCache(next.backgrounds)

    await storage.sync.clear()
    await storage.sync.set(next)

    sessionStorage.setItem('skipBookmarkSync', '1')

    return next
}

function isRemoteNewer(remoteIso: string, localIso: string): boolean {
    const remote = new Date(remoteIso).getTime()
    const local = new Date(localIso).getTime()

    if (Number.isNaN(remote) || Number.isNaN(local)) {
        return false
    }

    // Ignore sub-second drift: providers can return whole-second precision and our own
    // saved timestamp can be a few ms ahead/behind the value the API echoes back.
    return remote - local > 1000
}

function getSettingsTextAreaSync(): Sync | undefined {
    const textarea = document.getElementById('settings-data') as HTMLTextAreaElement | null
    const value = textarea?.value.trim()

    if (!value) {
        return
    }

    try {
        const parsed = JSON.parse(value) as Partial<Sync>

        if (parsed?.links) {
            return normalizeExternalSync(parsed)
        }

        throw 'Settings JSON is missing required fields.'
    } catch (_) {
        throw 'Invalid settings JSON.'
    }
}

function normalizeExternalSync(data: Partial<Sync>): Sync {
    return mergeImportedConfig(structuredClone(SYNC_DEFAULT), data)
}

function syncPayloadHash(data: Sync): string {
    const { selectedFolder: _, ...links } = data.links
    const notes = data.notes ? { records: data.notes.records } : undefined
    return stableStringify({ ...data, links, notes })
}

// 仅供集成测试访问内部函数；不要在生产代码中使用。
export const __testing = {
    applyDownloadedSync,
    syncPayloadHash,
}

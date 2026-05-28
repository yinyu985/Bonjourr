import { fetchGistUpdatedAt, findGistId, retrieveGist, sendGist, setGistStatus, setGistStatusNow } from './gist.ts'
import { isDistantUrlValid, receiveFromURL } from './url.ts'
import { saveConfigSnapshot } from './backup.ts'
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
// scheduleAutoUpload skips when syncLocked is true (we're mid-upload/-download
// and don't want to fight ourselves). But edits during an upload still need
// to propagate. We set this flag whenever a sync write is dropped because of
// the lock; the lock-holder re-schedules an upload on its way out so the
// debounce timer always exists when there's queued work.
let pendingUpload = false
const AUTO_UPLOAD_DEBOUNCE_MS = 30000
// 启动期间每开一个新标签页都会调一次 autoSyncOnStartup 拉 Gist。
// 频繁开标签页 = 短时间内打几十次 GitHub。同一会话 60s 内只查一次远端。
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
    if (local.syncType !== 'gist') {
        return
    }

    const token = local.gistToken
    const id = local.gistId

    if (!token || !id) {
        return
    }

    // 节流：60s 内已经查过远端就不再请求，直接信任本地 hash。
    // 否则每开一个新标签页都打 GitHub 一次，几秒钟开几个标签 = 暴打 API。
    const lastFetchedAt = local.gistLastFetchedAt ? new Date(local.gistLastFetchedAt).getTime() : 0
    const fetchedRecently = lastFetchedAt && Date.now() - lastFetchedAt < STARTUP_FETCH_THROTTLE_MS

    if (fetchedRecently) {
        const current = await bootstrapBookmarksFromConfig(await storage.sync.get())
        lastSyncedPayload = syncPayloadHash(current)
        return
    }

    syncLocked = true

    try {
        const result = await retrieveGist(token, id)
        await storage.local.set({ gistLastFetchedAt: new Date().toISOString() })

        if (local.gistLastSyncedAt && !isRemoteNewer(result.updatedAt, local.gistLastSyncedAt)) {
            const current = await bootstrapBookmarksFromConfig(await storage.sync.get())
            lastSyncedPayload = syncPayloadHash(current)
            return
        }

        const data = await storage.sync.get()
        const next = await applyDownloadedSync(data, result.sync)
        lastSyncedPayload = syncPayloadHash(next)
        await storage.local.set({ gistLastSyncedAt: result.updatedAt })
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

    const local = await storage.local.get(['gistId', 'gistToken', 'gistLastSyncedAt', 'syncType'])

    if (local.syncType !== 'gist' || !local.gistToken) {
        return
    }

    syncLocked = true

    try {
        const token = local.gistToken

        if (local.gistId && local.gistLastSyncedAt) {
            const remoteUpdatedAt = await fetchGistUpdatedAt(token, local.gistId)
            if (remoteUpdatedAt && isRemoteNewer(remoteUpdatedAt, local.gistLastSyncedAt)) {
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

        const result = await sendGist(token, local.gistId, latest)
        lastSyncedPayload = payload
        pendingUpload = false
        storage.local.set({ gistLastSyncedAt: result.updatedAt, gistId: result.id })
    } catch (err) {
        console.warn('Auto upload failed', err)
    } finally {
        releaseSyncLock()
    }
}

async function updateSyncOption(update: SyncUpdate): Promise<void> {
    const local = await storage.local.get([
        'gistId',
        'gistToken',
        'gistLastSyncedAt',
        'distantUrl',
        'syncType',
    ])

    if (update.down) {
        if (syncLocked) {
            gistsyncform.warn(tradThis('Sync in progress, please wait.'))
            return
        }

        syncLocked = true

        try {
            const data = await storage.sync.get()

            if (local.syncType === 'gist') {
                gistsyncform.load()

                try {
                    const id = local.gistId ?? ''
                    const token = local.gistToken ?? ''
                    const result = await retrieveGist(token, id)
                    const next = await applyDownloadedSync(data, result.sync)
                    lastSyncedPayload = syncPayloadHash(next)
                    await storage.local.set({
                        gistLastSyncedAt: result.updatedAt,
                        gistLastFetchedAt: new Date().toISOString(),
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

        if (local.syncType === 'gist') {
            // Hold the lock for the duration of the manual upload too —
            // otherwise auto-upload's debounced doAutoUpload could fire
            // partway through and double-send to GitHub.
            syncLocked = true
            gistsyncform.load()

            try {
                const token = local.gistToken ?? ''

                if (local.gistId && local.gistLastSyncedAt) {
                    const remoteUpdatedAt = await fetchGistUpdatedAt(token, local.gistId)
                    if (remoteUpdatedAt && isRemoteNewer(remoteUpdatedAt, local.gistLastSyncedAt)) {
                        gistsyncform.warn(tradThis('Remote Gist is newer than local. Please download first.'))
                        return
                    }
                }

                const latest = getSettingsTextAreaSync() ??
                    await bootstrapBookmarksFromConfig(await storage.sync.get())

                const result = await sendGist(token, local.gistId, latest)
                lastSyncedPayload = syncPayloadHash(latest)
                pendingUpload = false

                gistsyncform.accept()

                const localPatch: Partial<Local> = { gistLastSyncedAt: result.updatedAt }
                if (result.id !== local.gistId) {
                    local.gistId = result.id
                    localPatch.gistId = result.id
                }
                storage.local.set(localPatch)

                setGistStatusNow(local.gistId)
            } catch (error) {
                gistsyncform.warn(error as string)
            } finally {
                releaseSyncLock()
            }
        }
    }

    if (update.gistToken === '') {
        local.gistToken = ''
        local.gistId = ''
        local.gistLastSyncedAt = undefined
        storage.local.remove('gistToken')
        storage.local.remove('gistId')
        storage.local.remove('gistLastSyncedAt')
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
            const foundId = await findGistId(local.gistToken)

            local.gistId = foundId ?? ''
            // The previous token's last-sync timestamp is meaningless against
            // a different gist — clear it so isRemoteNewer doesn't compare a
            // stale local time against a fresh remote time and incorrectly
            // skip the next download.
            local.gistLastSyncedAt = undefined
            storage.local.set({ gistId: local.gistId, gistToken: local.gistToken })
            storage.local.remove('gistLastSyncedAt')
            storage.local.remove('gistLastFetchedAt')
            // Different gist, different content — force the next sync to
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
    const gistId = local?.gistId
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
                setGistStatus()
                break
            }

            bGistup?.removeAttribute('disabled')

            if (gistId) {
                bGistdown?.removeAttribute('disabled')
            }

            setGistStatus(gistToken, gistId)

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

    saveConfigSnapshot(current, 'sync-download')
    await replaceBookmarksFromConfig(current, next)
    holdBookmarkRefreshes()

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

    // Ignore sub-second drift: GitHub returns whole-second precision and our own
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

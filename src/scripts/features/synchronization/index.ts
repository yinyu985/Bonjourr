import { fetchGistUpdatedAt, findGistId, retrieveGist, sendGist, setGistStatus, setGistStatusNow } from './gist.ts'
import { isDistantUrlValid, receiveFromURL } from './url.ts'
import { dedupeSyncLinks } from './merge.ts'
import { bootstrapBookmarksFromConfig, renderLinksFromSync, replaceBookmarksFromConfig } from '../links/bookmarks.ts'
import { notes } from '../notes.ts'
import { onSettingsLoad } from '../../utils/onsettingsload.ts'
import { mergeImportedConfig } from '../../compatibility/apply.ts'
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
const AUTO_UPLOAD_DEBOUNCE_MS = 5000

export function synchronization(init?: Local, update?: SyncUpdate): void {
    if (init) {
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

    syncLocked = true

    try {
        const result = await retrieveGist(token, id)

        if (local.gistLastSyncedAt && !isRemoteNewer(result.updatedAt, local.gistLastSyncedAt)) {
            return
        }

        const data = await storage.sync.get()
        const next = await applyDownloadedSync(data, result.sync)
        lastSyncedPayload = syncPayloadHash(next)
        await storage.local.set({ gistLastSyncedAt: result.updatedAt })
        fadeOut()
    } catch (err) {
        console.warn('Auto sync on startup failed', err)
    } finally {
        syncLocked = false
    }
}

function scheduleAutoUpload(): void {
    if (syncLocked) {
        return
    }

    if (autoUploadTimer) {
        clearTimeout(autoUploadTimer)
    }

    autoUploadTimer = setTimeout(doAutoUpload, AUTO_UPLOAD_DEBOUNCE_MS)
}

async function doAutoUpload(): Promise<void> {
    autoUploadTimer = 0

    if (syncLocked) {
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
                return
            }
        }

        const latest = await bootstrapBookmarksFromConfig(await storage.sync.get())
        const payload = syncPayloadHash(latest)

        if (payload === lastSyncedPayload) {
            return
        }

        const result = await sendGist(token, local.gistId, latest)
        lastSyncedPayload = payload
        storage.local.set({ gistLastSyncedAt: result.updatedAt, gistId: result.id })
    } catch (err) {
        console.warn('Auto upload failed', err)
    } finally {
        syncLocked = false
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
                    await storage.local.set({ gistLastSyncedAt: result.updatedAt })
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
            syncLocked = false
        }
    }

    if (update.up) {
        if (syncLocked) {
            gistsyncform.warn(tradThis('Sync in progress, please wait.'))
            return
        }

        if (local.syncType === 'gist') {
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

                gistsyncform.accept()

                const localPatch: Partial<Local> = { gistLastSyncedAt: result.updatedAt }
                if (!local.gistId) {
                    local.gistId = result.id
                    localPatch.gistId = result.id
                }
                storage.local.set(localPatch)

                setGistStatusNow()
            } catch (error) {
                gistsyncform.warn(error as string)
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
            storage.local.set({ gistId: local.gistId, gistToken: local.gistToken })

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
        case 'off':
        case 'browser': {
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
    return ['browser', 'gist', 'url', 'off'].includes(val)
}

async function applyDownloadedSync(current: Sync, incoming: Partial<Sync>): Promise<Sync> {
    const normalized = normalizeExternalSync(incoming)
    let next = dedupeSyncLinks(structuredClone(normalized))

    // Snapshot the soon-to-be-overwritten config so a failed clear+set still leaves
    // the user with a recoverable copy in localStorage. Web mode shares a 5 MB
    // localStorage quota with the live config, so cap the snapshot size.
    try {
        const snapshot = JSON.stringify(current)
        if (snapshot.length < 2_000_000) {
            localStorage.setItem('bonjourr-archive-pre-sync', snapshot)
        }
    } catch (_) {
        // localStorage might be full; the sync still proceeds.
    }

    // Browser bookmarks are reconciled to match incoming exactly: bookmarks present
    // locally but absent from the remote config are removed. This is what makes
    // deletions on one device propagate to others.
    await replaceBookmarksFromConfig(current, normalized)

    await storage.sync.clear()
    await storage.sync.set(next)

    next = await bootstrapBookmarksFromConfig(next)
    await storage.sync.set(next)

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
            return dedupeSyncLinks(normalizeExternalSync(parsed))
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
    return JSON.stringify({ ...data, links, notes })
}

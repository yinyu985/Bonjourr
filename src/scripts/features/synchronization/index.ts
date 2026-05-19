import { findGistId, retrieveGist, sendGist, setGistStatus, setGistStatusNow } from './gist.ts'
import { isDistantUrlValid, receiveFromURL } from './url.ts'
import { dedupeSyncLinks } from './merge.ts'
import { bootstrapBookmarksFromConfig, renderLinksFromSync, restoreBookmarksFromConfig } from '../links/bookmarks.ts'
import { onSettingsLoad } from '../../utils/onsettingsload.ts'
import { mergeImportedConfig } from '../../compatibility/apply.ts'
import { networkForm } from '../../shared/form.ts'
import { fadeOut } from '../../shared/dom.ts'
import { SYNC_DEFAULT } from '../../defaults.ts'
import { storage } from '../../storage.ts'

import type { Local, SyncType } from '../../../types/local.ts'
import type { Sync } from '../../../types/sync.ts'

interface SyncUpdate {
    type?: string
    freq?: string
    url?: string
    status?: string
    gistToken?: string
    firefoxPersist?: boolean
    down?: true
    up?: true
}

const gistsyncform = networkForm('f_gistsync')
const urlsyncform = networkForm('f_urlsync')

export function synchronization(init?: Local, update?: SyncUpdate): void {
    if (init) {
        onSettingsLoad(() => {
            toggleSyncSettingsOption(init)
            setTimeout(() => handleStoragePersistence(init.syncType), 200)
        })
    }

    if (update) {
        updateSyncOption(update)
    }
}

async function updateSyncOption(update: SyncUpdate): Promise<void> {
    const local = await storage.local.get(['gistId', 'gistToken', 'distantUrl', 'syncType'])

    if (update.down) {
        const data = await storage.sync.get()

        if (local.syncType === 'gist') {
            gistsyncform.load()

            try {
                const id = local.gistId ?? ''
                const token = local.gistToken ?? ''
                const incoming = normalizeExternalSync(await retrieveGist(token, id))
                const update = await mergeDownloadedSync(data, incoming)
                await renderLinksFromSync(update)
                gistsyncform.accept()
                fadeOut()
            } catch (err) {
                gistsyncform.warn(err as string)
            }
        }

        if (local.syncType === 'url') {
            urlsyncform.load()

            try {
                const incoming = normalizeExternalSync(await receiveFromURL(local.distantUrl))
                const update = await mergeDownloadedSync(data, incoming)
                await renderLinksFromSync(update)
                urlsyncform.accept()
                fadeOut()
            } catch (err) {
                urlsyncform.warn(err as string)
            }
        }
    }

    if (update.up) {
        if (local.syncType === 'gist') {
            gistsyncform.load()

            try {
                const token = local.gistToken ?? ''
                const latest = getSettingsTextAreaSync() ??
                    await bootstrapBookmarksFromConfig(await storage.sync.get())

                const id = await sendGist(token, local.gistId, latest)

                gistsyncform.accept()

                if (!local.gistId) {
                    local.gistId = id
                    storage.local.set({ gistId: id })
                }

                setGistStatusNow()
            } catch (error) {
                gistsyncform.warn(error as string)
            }
        }
    }

    if (update.gistToken === '') {
        local.gistToken = ''
        local.gistId = ''
        storage.local.remove('gistToken')
        storage.local.remove('gistId')
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
            document.getElementById('sync-freq')?.classList.remove('shown')
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

async function mergeDownloadedSync(current: Sync, incoming: Sync): Promise<Sync> {
    incoming = normalizeExternalSync(incoming)
    let update = dedupeSyncLinks(structuredClone(incoming))

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

    await storage.sync.clear()
    await storage.sync.set(update)

    // restoreBookmarksFromConfig is append-only: it never deletes
    // existing browser bookmarks, only adds missing ones from the config.
    const restored = await restoreBookmarksFromConfig(incoming)

    if (restored) {
        update = await bootstrapBookmarksFromConfig(update)
        await storage.sync.set(update)
    }

    return update
}

function getSettingsTextAreaSync(): Sync | undefined {
    const textarea = document.getElementById('settings-data') as HTMLTextAreaElement | null
    const value = textarea?.value.trim()

    if (!value) {
        return
    }

    try {
        const parsed = JSON.parse(value) as Partial<Sync>

        if (parsed?.about) {
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

// function isSyncFreq(val: string): val is SyncFreq {
// 	return ['newtabs', 'start', 'manual'].includes(val)
// }

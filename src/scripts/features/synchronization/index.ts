import { getRemoteProvider } from './provider.ts'
import { SyncNetworkError } from './errors.ts'
import { waitForPendingBackgroundWrites } from '../backgrounds/index.ts'
import { resetBackgroundRuntimeCache } from '../backgrounds/cache.ts'
import {
    buildBookmarkSnapshotFromConfig,
    holdBookmarkRefreshes,
    replaceBookmarksFromConfig,
} from '../links/bookmarks.ts'
import { onSettingsLoad } from '../../utils/onsettingsload.ts'
import { mergeImportedConfig } from '../../compatibility/apply.ts'
import { stableStringify } from '../../utils/stringify.ts'
import { getLang, tradThis } from '../../utils/translations.ts'
import { fadeOut } from '../../shared/dom.ts'
import { networkForm } from '../../shared/form.ts'
import { SYNC_DEFAULT } from '../../defaults.ts'
import { storage } from '../../storage.ts'

import type { Local, SyncType } from '../../../types/local.ts'
import type { Sync } from '../../../types/sync.ts'
import type { RemoteMetadata, RemoteProvider } from './provider.ts'

interface SyncUpdate {
    type?: string
    gistToken?: string
    firefoxPersist?: boolean
    down?: true
    up?: true
}

type StartupSyncResult = 'skipped' | 'checked' | 'downloaded' | 'conflict' | 'failed'
type RemoteFreshness = 'current' | 'newer' | 'unknown'

interface StartupPayloadDecision {
    pendingUpload: boolean
    runtimePayload: string
    persistedPayload?: string
}

const gistsyncform = networkForm('f_gistsync')

let syncLocked = false
let autoUploadTimer = 0
let lastSyncedPayload = ''
let confirmRemoteOverwrite = false
let startupFreshnessChecked = true
// scheduleAutoUpload skips when syncLocked is true (we're mid-upload/-download
// and don't want to fight ourselves). But edits during an upload still need
// to propagate. We set this flag whenever a sync write is dropped because of
// the lock; the lock-holder re-schedules an upload on its way out so the
// debounce timer always exists when there's queued work.
let pendingUpload = false
// Startup sync can detect a state where it must NOT auto-overwrite either side
// (no sync baseline, or a real local-vs-remote conflict). We park a human
// message here and surface it once the settings panel mounts, so the user
// can pick Upload (local wins) or Download (remote wins) by hand.
let pendingConflictMessage = ''
const AUTO_UPLOAD_DEBOUNCE_MS = 30000

export async function synchronization(init?: Local, update?: SyncUpdate): Promise<StartupSyncResult | void> {
    let startupResult: StartupSyncResult | undefined

    if (init) {
        lastSyncedPayload = init.lastSyncedPayload ?? ''

        // Legacy: 'browser' was a Chrome/Firefox-Sync option that never did
        // anything (storage.ts uses chrome.storage.local even for the 'sync'
        // namespace). The option is gone — fold any old value into 'off' so
        // the UI matches storage instead of falling through every switch.
        if ((init.syncType as string) === 'browser') {
            init.syncType = 'off'
            await storage.local.set({ syncType: 'off' })
        }

        onSettingsLoad(() => {
            toggleSyncSettingsOption(init)
            setTimeout(() => handleStoragePersistence(init.syncType), 200)
            // If startup sync parked a conflict / no-baseline message, surface
            // it now that the settings form actually exists.
            if (pendingConflictMessage) {
                gistsyncform.warn(pendingConflictMessage)
            }
        })

        startupFreshnessChecked = !needsStartupFreshnessCheck(init)
        globalThis.addEventListener('bonjourr-sync-write', scheduleAutoUpload)
        startupResult = await autoSyncOnStartup(init)
    }

    if (update) {
        await updateSyncOption(update)
    }

    return startupResult
}

async function autoSyncOnStartup(local: Local): Promise<StartupSyncResult> {
    const provider = getRemoteProvider(local)

    if (!provider || !needsStartupFreshnessCheck(local)) {
        return 'skipped'
    }

    syncLocked = true

    try {
        return await completeStartupFreshnessCheck(local, provider)
    } catch (err) {
        // 断网/瞬时网络故障不是异常状况：console.warn 会被 Chrome 扩展错误
        // 面板收集并吓到用户。降级为 info，改在设置面板的同步表单上提示；
        // 自动上传保持暂停（freshness 未过）。
        if (err instanceof SyncNetworkError) {
            console.info('Auto sync on startup skipped: network unavailable')
            surfaceSyncConflict(err.message)
        } else {
            console.warn('Auto sync on startup failed', err)
        }
        return 'failed'
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

    if (!startupFreshnessChecked && provider.getResourceId(local)) {
        pendingUpload = true
        return
    }

    syncLocked = true

    try {
        const freshness = await remoteFreshness(local, provider)
        if (freshness !== 'current') {
            pendingUpload = false
            if (freshness === 'unknown') {
                console.info('Auto upload skipped: cannot verify remote freshness')
            }
            return
        }

        const latest = await buildUploadSnapshot()
        const payload = syncPayloadHash(latest)

        if (payload === lastSyncedPayload) {
            pendingUpload = false
            return
        }

        const result = await provider.upload(local, latest)
        lastSyncedPayload = payload
        pendingUpload = false
        await recordRemoteSyncSuccess(provider, result, payload)
    } catch (err) {
        if (err instanceof SyncNetworkError) {
            console.info('Auto upload skipped: network unavailable')
        } else {
            console.warn('Auto upload failed', err)
        }
    } finally {
        releaseSyncLock()
    }
}

function needsStartupFreshnessCheck(local: Local): boolean {
    const provider = getRemoteProvider(local)
    return !!provider?.isEnabled(local) && provider.isAuthorized(local) && !!provider.getResourceId(local)
}

async function completeStartupFreshnessCheck(
    local: Local,
    provider: RemoteProvider,
): Promise<StartupSyncResult> {
    const result = await provider.download(local)
    await storage.local.set(provider.fetchedPatch(new Date().toISOString()))

    const lastSyncedAt = provider.getLastSyncedAt(local)

    // SPEC §2.8 / 缺失时间戳规则：没有 remoteLastSyncedAt 基线时，本机无法
    // 可靠判断远程是否"较新"。自动流程不得覆盖任意一侧；只记 fetched 状态，
    // 提示用户手动上传或下载来建立基线。绝不能在这里把远程内容盖到本机。
    if (!lastSyncedAt) {
        startupFreshnessChecked = false
        surfaceSyncConflict(buildSyncConflictMessage(
            tradThis('Remote sync has no baseline yet.'),
            tradThis('Click Get to download remote, or Send to upload local.'),
            local.localConfigUpdatedAt,
            result.metadata.updatedAt,
        ))
        return 'conflict'
    }

    const data = await storage.sync.get()
    const current = await buildUploadSnapshot(data)
    const currentPayload = syncPayloadHash(current)
    const remotePayload = syncPayloadHash(normalizeExternalSync(result.sync))

    if (!isRemoteNewer(result.metadata.updatedAt, lastSyncedAt)) {
        const decision = startupPayloadDecision(local, provider, remotePayload, currentPayload, lastSyncedPayload)

        lastSyncedPayload = decision.runtimePayload
        pendingUpload = decision.pendingUpload || pendingUpload

        if (decision.persistedPayload) {
            await storage.local.set({ lastSyncedPayload: decision.persistedPayload })
        }

        startupFreshnessChecked = true
        return 'checked'
    }

    // Remote is newer. Before letting remote wins, make sure the local side
    // has no unsynced edits — otherwise this is a conflict (SPEC §2.7) and we
    // must not silently overwrite either side.
    const decision = startupPayloadDecision(local, provider, remotePayload, currentPayload, lastSyncedPayload)

    if (decision.pendingUpload) {
        // Local has unsynced edits AND remote moved on → conflict. Stop and
        // let the user pick Upload (local wins) or Download (remote wins).
        startupFreshnessChecked = false
        surfaceSyncConflict(buildSyncConflictMessage(
            tradThis('Local and remote both changed since last sync.'),
            tradThis('Click Send to overwrite remote, or Get to overwrite local.'),
            local.localConfigUpdatedAt,
            result.metadata.updatedAt,
        ))
        return 'conflict'
    }

    // Remote is newer and the local side is clean → safe to auto-download.
    const next = await applyDownloadedSync(data, result.sync)
    lastSyncedPayload = syncPayloadHash(next)
    await recordRemoteSyncSuccess(provider, result.metadata, lastSyncedPayload)
    // Just downloaded fresh remote state — any writes that landed during
    // the download are reflected in `next`, so drop the pending flag.
    pendingUpload = false
    startupFreshnessChecked = true
    fadeOut()
    return 'downloaded'
}

// Park a conflict message and render it once the settings panel is mounted
// (startup sync runs before the settings DOM exists). Picked up by the
// onSettingsLoad callback in synchronization().
function surfaceSyncConflict(message: string): void {
    pendingConflictMessage = message
}

function clearSyncConflict(): void {
    pendingConflictMessage = ''
    gistsyncform.reset()
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
                    await recordRemoteSyncSuccess(
                        provider,
                        result.metadata,
                        lastSyncedPayload,
                        new Date().toISOString(),
                    )
                    pendingUpload = false
                    startupFreshnessChecked = true
                    clearSyncConflict()
                    gistsyncform.accept()
                    fadeOut()
                } catch (err) {
                    gistsyncform.warn(err as string)
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
                const freshness = await remoteFreshness(local, provider)
                if (freshness === 'unknown') {
                    gistsyncform.warn(tradThis('Cannot connect to GitHub.'))
                    return
                }

                if (freshness === 'newer' && !confirmRemoteOverwrite) {
                    confirmRemoteOverwrite = true
                    gistsyncform.warn(
                        tradThis('Remote data is newer than local. Click send again to overwrite remote.'),
                    )
                    return
                }

                const latest = await buildUploadSnapshot()

                const result = await provider.upload(local, latest)
                lastSyncedPayload = syncPayloadHash(latest)
                pendingUpload = false
                confirmRemoteOverwrite = false
                startupFreshnessChecked = true
                clearSyncConflict()

                gistsyncform.accept()

                await recordRemoteSyncSuccess(provider, result, lastSyncedPayload)
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
        startupFreshnessChecked = true
        clearSyncConflict()
        await storage.local.remove('gistToken')
        for (const key of getRemoteProvider({ ...local, syncType: 'gist' })?.clearPatch() ?? []) {
            await storage.local.remove(key)
        }
        gistsyncform.accept()
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
            startupFreshnessChecked = !needsStartupFreshnessCheck({ ...local, syncType: 'gist' })
            // The previous token's last-sync timestamp is meaningless against
            // a different remote resource — clear it so isRemoteNewer doesn't compare a
            // stale local time against a fresh remote time and incorrectly
            // skip the next download.
            local.remoteLastSyncedAt = undefined
            await storage.local.set({
                gistToken: local.gistToken,
                remoteResourceId: local.remoteResourceId,
            })
            for (const key of gist?.clearPatch() ?? []) {
                if (key !== 'remoteResourceId') {
                    await storage.local.remove(key)
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

    if (isSyncType(update.type)) {
        local.syncType = update.type
        startupFreshnessChecked = !needsStartupFreshnessCheck(local)
        await storage.local.set({ syncType: local.syncType })

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

function toggleSyncSettingsOption(local?: Local): void {
    const provider = getRemoteProvider(local)
    const resourceId = local ? provider?.getResourceId(local) : undefined
    const gistToken = local?.gistToken
    const type = local?.syncType

    const iGistsync = document.querySelector<HTMLInputElement>('#i_gistsync')
    const bGistdown = document.querySelector<HTMLInputElement>('#b_gistdown')
    const bGistup = document.querySelector<HTMLInputElement>('#b_gistup')

    bGistdown?.setAttribute('disabled', '')
    bGistup?.setAttribute('disabled', '')

    if (iGistsync && gistToken) {
        iGistsync.value = gistToken
    }

    const choseStoragePersistence = localStorage.choseStoragePersistence === 'true'
    document.getElementById('disabled-sync')?.classList.toggle('shown', !choseStoragePersistence)

    switch (type) {
        case 'off': {
            document.getElementById('gist-sync')?.classList.remove('shown')
            break
        }

        case 'gist': {
            document.getElementById('gist-sync')?.classList.add('shown')
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

        default:
    }
}

// Type check

function isSyncType(val = ''): val is SyncType {
    return ['gist', 'off'].includes(val)
}

async function applyDownloadedSync(current: Sync, incoming: Partial<Sync>): Promise<Sync> {
    const next = normalizeExternalSync(incoming)

    await replaceBookmarksFromConfig(current, next)
    holdBookmarkRefreshes()
    await resetBackgroundRuntimeCache(next.backgrounds)

    storage.stageSyncForReload(next)
    await storage.sync.clear()
    await storage.sync.set(next)

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

function startupPayloadDecision(
    local: Local,
    provider: RemoteProvider,
    remotePayload: string,
    currentPayload: string,
    runtimePayload: string,
): StartupPayloadDecision {
    const syncedPayload = local.lastSyncedPayload || runtimePayload || remotePayload
    const contentChangedSinceSync = syncedPayload
        ? currentPayload !== syncedPayload
        : hasUnsyncedLocalTimestamp(local, provider)

    if (contentChangedSinceSync) {
        return {
            pendingUpload: true,
            runtimePayload: syncedPayload,
        }
    }

    return {
        pendingUpload: false,
        runtimePayload: currentPayload,
        persistedPayload: currentPayload,
    }
}

function hasUnsyncedLocalTimestamp(local: Local, provider: RemoteProvider): boolean {
    const localUpdatedAt = local.localConfigUpdatedAt
    const lastSyncedAt = provider.getLastSyncedAt(local)

    return !!localUpdatedAt && !!lastSyncedAt && isRemoteNewer(localUpdatedAt, lastSyncedAt)
}

async function remoteFreshness(local: Local, provider: RemoteProvider): Promise<RemoteFreshness> {
    const lastSyncedAt = provider.getLastSyncedAt(local)

    if (!provider.getResourceId(local) || !lastSyncedAt) {
        return 'current'
    }

    const remoteUpdatedAt = await provider.fetchUpdatedAt(local)

    if (!remoteUpdatedAt) {
        return 'unknown'
    }

    return isRemoteNewer(remoteUpdatedAt, lastSyncedAt) ? 'newer' : 'current'
}

async function buildUploadSnapshot(data?: Sync): Promise<Sync> {
    await waitForPendingBackgroundWrites()
    return await buildBookmarkSnapshotFromConfig(data ?? await storage.sync.get())
}

async function recordRemoteSyncSuccess(
    provider: RemoteProvider,
    metadata: RemoteMetadata,
    payload: string,
    fetchedAt?: string,
): Promise<void> {
    await storage.local.set({
        ...provider.syncedPatch(metadata),
        ...(fetchedAt ? provider.fetchedPatch(fetchedAt) : {}),
        lastSyncedPayload: payload,
    })
    provider.setStatusNow(metadata)
}

function normalizeExternalSync(data: Partial<Sync>): Sync {
    return mergeImportedConfig(structuredClone(SYNC_DEFAULT), data)
}

function syncPayloadHash(data: Sync): string {
    const { selectedFolder: _, ...links } = data.links
    const notes = data.notes ? { records: data.notes.records } : undefined
    return stableStringify({ ...data, links, notes })
}

function buildSyncConflictMessage(
    intro: string,
    outro: string,
    localUpdatedAt: string | undefined,
    remoteUpdatedAt: string | undefined,
): string {
    return [
        intro,
        `${tradThis('Local last changed')}: ${formatSyncTime(localUpdatedAt)}`,
        `${tradThis('Remote last changed')}: ${formatSyncTime(remoteUpdatedAt)}`,
        outro,
    ].join('\n')
}

function formatSyncTime(iso?: string): string {
    const time = iso ? new Date(iso).getTime() : Number.NaN

    if (Number.isNaN(time)) {
        return tradThis('unknown')
    }

    return new Date(time).toLocaleString(getLang(), {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    })
}

// 仅供集成测试访问内部函数；不要在生产代码中使用。
export const __testing = {
    applyDownloadedSync,
    autoSyncOnStartup,
    buildUploadSnapshot,
    completeStartupFreshnessCheck,
    doAutoUpload,
    getPendingConflictMessage(): string {
        return pendingConflictMessage
    },
    remoteFreshness,
    resetSyncRuntimeForTests(payload = ''): void {
        if (autoUploadTimer) {
            clearTimeout(autoUploadTimer)
        }
        syncLocked = false
        autoUploadTimer = 0
        lastSyncedPayload = payload
        confirmRemoteOverwrite = false
        startupFreshnessChecked = true
        pendingUpload = false
        pendingConflictMessage = ''
    },
    startupPayloadDecision,
    syncPayloadHash,
}

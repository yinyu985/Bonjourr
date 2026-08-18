import { getRemoteProvider } from './provider.ts'
import { SyncNetworkError } from './errors.ts'
import { waitForPendingBackgroundWrites } from '../backgrounds/index.ts'
import { resetBackgroundRuntimeCache } from '../backgrounds/cache.ts'
import { saveExternalConfigSnapshot } from './backup.ts'
import { assertValidNormalizedSync, assertValidSyncInput } from './validation.ts'
import { acquireSynchronizationLock } from './lock.ts'
import { buildBookmarkSnapshotFromConfig, replaceBookmarksFromConfig } from '../links/bookmarks.ts'
import { onSettingsLoad } from '../../utils/onsettingsload.ts'
import { flushPendingDebounces } from '../../utils/debounce.ts'
import { mergeImportedConfig, removeDeprecatedFields } from '../../compatibility/apply.ts'
import { stableStringify } from '../../utils/stringify.ts'
import { getLang, tradThis } from '../../utils/translations.ts'
import { fadeOut } from '../../shared/dom.ts'
import { networkForm } from '../../shared/form.ts'
import { EXTENSION, SYNC_DEFAULT } from '../../defaults.ts'
import { storage } from '../../storage.ts'

import type { Local, SyncType } from '../../../types/local.ts'
import type { Sync, SyncSnapshot } from '../../../types/sync.ts'
import type { RemoteMetadata, RemoteProvider } from './provider.ts'

interface SyncUpdate {
    type?: string
    gistToken?: string
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
let syncUiReady = false
// scheduleAutoUpload skips when syncLocked is true (we're mid-upload/-download
// and don't want to fight ourselves). But edits during an upload still need
// to propagate. We set this flag whenever a sync write is dropped because of
// the lock; the lock-holder re-schedules an upload on its way out so the
// debounce timer always exists when there's queued work.
let pendingUpload = false
let mutationGeneration = 0
// Startup sync can detect a state where it must NOT auto-overwrite either side
// (no sync baseline, or a real local-vs-remote conflict). We park a human
// message here and surface it once the settings panel mounts, so the user
// can pick Upload (local wins) or Download (remote wins) by hand.
let pendingConflictMessage = ''
const AUTO_UPLOAD_DEBOUNCE_MS = 30000
const CROSS_CONTEXT_RETRY_MS = 5000

export async function synchronization(init?: Local, update?: SyncUpdate): Promise<StartupSyncResult | void> {
    let startupResult: StartupSyncResult | undefined

    if (init) {
        lastSyncedPayload = init.lastSyncedPayload ?? ''

        // Remote sync requires a live browser-native bookmark snapshot. The
        // plain web build intentionally has no such API and therefore stays
        // fail-closed instead of uploading an empty bookmark tree.
        if (!EXTENSION?.bookmarks && init.syncType !== 'off') {
            init.syncType = 'off'
            await storage.local.set({ syncType: 'off' })
        }

        // Legacy: 'browser' was a retired browser-storage option that never did
        // anything (storage.ts uses chrome.storage.local even for the 'sync'
        // namespace). The option is gone — fold any old value into 'off' so
        // the UI matches storage instead of falling through every switch.
        if ((init.syncType as string) === 'browser') {
            init.syncType = 'off'
            await storage.local.set({ syncType: 'off' })
        }

        onSettingsLoad(() => {
            syncUiReady = true
            toggleSyncSettingsOption(init)
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

/**
 * Serialize local destructive mutations with remote upload/download work in
 * this page and every other new-tab page in the same Chrome profile.
 */
export async function withSynchronizationLock<T>(action: () => Promise<T>): Promise<T> {
    if (syncLocked) throw new Error('Synchronization is already in progress')

    const releaseRemoteLock = await acquireSynchronizationLock()
    if (!releaseRemoteLock) throw new Error('Synchronization is already in progress in another tab')
    syncLocked = true

    try {
        return await action()
    } finally {
        releaseRemoteLock()
        releaseSyncLock()
    }
}

async function autoSyncOnStartup(local: Local): Promise<StartupSyncResult> {
    const provider = getRemoteProvider(local)

    if (!provider || !needsStartupFreshnessCheck(local)) {
        return 'skipped'
    }

    const releaseRemoteLock = await acquireSynchronizationLock(true)
    if (!releaseRemoteLock) return 'failed'

    syncLocked = true

    try {
        const freshLocal = await storage.local.get()
        const freshProvider = getRemoteProvider(freshLocal)
        if (!freshProvider || !needsStartupFreshnessCheck(freshLocal)) return 'skipped'
        return await completeStartupFreshnessCheck(freshLocal, freshProvider)
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
        releaseRemoteLock()
        releaseSyncLock()
    }
}

function scheduleAutoUpload(): void {
    mutationGeneration += 1
    confirmRemoteOverwrite = false
    void storage.local.set({ localConfigUpdatedAt: new Date().toISOString() }).catch((err) => {
        console.warn('Failed to record local configuration change', err)
    })

    queueAutoUpload()
}

function queueAutoUpload(): void {
    if (syncLocked) {
        // The current sync writer (download or upload) will re-schedule us
        // when it releases the lock — see releaseSyncLock().
        pendingUpload = true
        return
    }

    if (autoUploadTimer) {
        clearTimeout(autoUploadTimer)
    }

    scheduleAutoUploadTimer(AUTO_UPLOAD_DEBOUNCE_MS)
}

function scheduleAutoUploadTimer(delay: number): void {
    autoUploadTimer = setTimeout(() => {
        void doAutoUpload().catch((err) => {
            console.warn('Automatic synchronization task failed unexpectedly', err)
            pendingUpload = true
            if (!syncLocked) scheduleAutoUploadTimer(CROSS_CONTEXT_RETRY_MS)
        })
    }, delay)
}

function releaseSyncLock(): void {
    syncLocked = false
    if (pendingUpload) {
        pendingUpload = false
        queueAutoUpload()
    }
}

async function doAutoUpload(): Promise<void> {
    autoUploadTimer = 0

    if (syncLocked) {
        pendingUpload = true
        return
    }

    let local: Local
    let provider: RemoteProvider | undefined

    try {
        local = await storage.local.get()
        provider = getRemoteProvider(local)
    } catch (err) {
        console.warn('Auto upload cannot read synchronization state', err)
        pendingUpload = true
        scheduleAutoUploadTimer(CROSS_CONTEXT_RETRY_MS)
        return
    }

    if (!provider?.isEnabled(local) || !provider.isAuthorized(local)) {
        return
    }

    let releaseRemoteLock: (() => void) | undefined
    try {
        releaseRemoteLock = await acquireSynchronizationLock()
    } catch (err) {
        console.warn('Auto upload cannot acquire synchronization lock', err)
    }
    if (!releaseRemoteLock) {
        pendingUpload = true
        scheduleAutoUploadTimer(CROSS_CONTEXT_RETRY_MS)
        return
    }

    syncLocked = true

    try {
        local = await storage.local.get()
        provider = getRemoteProvider(local)
        if (!provider?.isEnabled(local) || !provider.isAuthorized(local)) return
        if (local.lastSyncedPayload) lastSyncedPayload = local.lastSyncedPayload

        if (
            provider.getResourceId(local) &&
            (!startupFreshnessChecked || !provider.getLastSyncedAt(local))
        ) {
            const startupResult = await completeStartupFreshnessCheck(local, provider)
            if (startupResult === 'conflict') pendingUpload = false
            if (startupResult !== 'checked') return
            local = await storage.local.get()
            provider = getRemoteProvider(local)
            if (!provider?.isEnabled(local) || !provider.isAuthorized(local)) return
        }

        const freshness = await remoteFreshness(local, provider)
        if (freshness !== 'current') {
            pendingUpload = freshness === 'unknown'
            if (freshness === 'unknown') {
                console.info('Auto upload skipped: cannot verify remote freshness')
            } else {
                startupFreshnessChecked = false
                surfaceSyncConflict(buildSyncConflictMessage(
                    tradThis('Remote data changed before automatic upload.'),
                    tradThis('Click Send to overwrite remote, or Get to overwrite local.'),
                    local.localConfigUpdatedAt,
                    undefined,
                ))
            }
            return
        }

        const uploadGeneration = mutationGeneration
        const latest = await buildUploadSnapshot()
        if (mutationGeneration !== uploadGeneration) {
            pendingUpload = true
            return
        }
        const payload = syncPayloadHash(latest)

        if (payload === lastSyncedPayload) {
            pendingUpload = mutationGeneration !== uploadGeneration
            return
        }

        // Bookmark/background snapshotting can take time. Re-check immediately
        // before the write so a remote edit in that window cannot be silently
        // overwritten. (The provider API has no atomic compare-and-swap.)
        const finalFreshness = await remoteFreshness(local, provider)
        if (finalFreshness !== 'current') {
            pendingUpload = finalFreshness === 'unknown'
            if (finalFreshness === 'newer') {
                startupFreshnessChecked = false
                surfaceSyncConflict(buildSyncConflictMessage(
                    tradThis('Remote data changed before automatic upload.'),
                    tradThis('Click Send to overwrite remote, or Get to overwrite local.'),
                    local.localConfigUpdatedAt,
                    undefined,
                ))
            }
            return
        }

        const result = await provider.upload(local, latest)
        lastSyncedPayload = payload
        pendingUpload = mutationGeneration !== uploadGeneration
        await recordRemoteSyncSuccess(provider, result, payload)
    } catch (err) {
        if (err instanceof SyncNetworkError) {
            console.info('Auto upload skipped: network unavailable')
        } else {
            console.warn('Auto upload failed', err)
        }
        pendingUpload = true
    } finally {
        releaseRemoteLock()
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
    assertValidRemoteMetadata(result.metadata)
    const normalizedRemote = normalizeExternalSync(result.sync)
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

    const current = await buildUploadSnapshot()
    const currentPayload = syncPayloadHash(current)
    const remotePayload = syncPayloadHash(normalizedRemote)

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
    const next = await applyDownloadedSync(current, normalizedRemote)
    lastSyncedPayload = syncPayloadHash(next)
    await recordRemoteSyncSuccess(provider, result.metadata, lastSyncedPayload)
    startupFreshnessChecked = true
    fadeOut()
    return 'downloaded'
}

// Park a conflict message and render it once the settings panel is mounted
// (startup sync runs before the settings DOM exists). Picked up by the
// onSettingsLoad callback in synchronization().
function surfaceSyncConflict(message: string): void {
    pendingConflictMessage = message
    if (syncUiReady) gistsyncform.warn(message)
}

function clearSyncConflict(): void {
    pendingConflictMessage = ''
    gistsyncform.reset()
}

async function updateSyncOption(update: SyncUpdate): Promise<void> {
    const local = await storage.local.get()
    const provider = getRemoteProvider(local)

    if (
        !EXTENSION?.bookmarks && (update.down || update.up || update.gistToken !== undefined || update.type === 'gist')
    ) {
        local.syncType = 'off'
        await storage.local.set({ syncType: 'off' })
        toggleSyncSettingsOption(local)
        gistsyncform.warn(tradThis('Bookmark sync is only available in the browser extension.'))
        return
    }

    if (update.down) {
        if (syncLocked) {
            gistsyncform.warn(tradThis('Sync in progress, please wait.'))
            return
        }

        const releaseRemoteLock = await acquireSynchronizationLock()
        if (!releaseRemoteLock) {
            gistsyncform.warn(tradThis('Sync in progress, please wait.'))
            return
        }

        syncLocked = true

        try {
            const lockedLocal = await storage.local.get()
            const lockedProvider = getRemoteProvider(lockedLocal)
            if (lockedProvider?.isEnabled(lockedLocal)) {
                gistsyncform.load()

                try {
                    const result = await lockedProvider.download(lockedLocal)
                    assertValidRemoteMetadata(result.metadata)
                    const current = await buildUploadSnapshot()
                    const next = await applyDownloadedSync(current, result.sync)
                    lastSyncedPayload = syncPayloadHash(next)
                    await recordRemoteSyncSuccess(
                        lockedProvider,
                        result.metadata,
                        lastSyncedPayload,
                        new Date().toISOString(),
                    )
                    startupFreshnessChecked = true
                    clearSyncConflict()
                    gistsyncform.accept()
                    fadeOut()
                } catch (err) {
                    gistsyncform.warn(err as string)
                }
            }
        } finally {
            releaseRemoteLock()
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
            const releaseRemoteLock = await acquireSynchronizationLock()
            if (!releaseRemoteLock) {
                gistsyncform.warn(tradThis('Sync in progress, please wait.'))
                return
            }

            syncLocked = true
            gistsyncform.load()

            try {
                const lockedLocal = await storage.local.get()
                const lockedProvider = getRemoteProvider(lockedLocal)
                if (!lockedProvider?.isEnabled(lockedLocal) || !lockedProvider.isAuthorized(lockedLocal)) {
                    gistsyncform.warn(tradThis('Invalid token.'))
                    return
                }
                if (lockedLocal.lastSyncedPayload) lastSyncedPayload = lockedLocal.lastSyncedPayload

                const freshness = await remoteFreshness(lockedLocal, lockedProvider)
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

                const uploadGeneration = mutationGeneration
                const latest = await buildUploadSnapshot()
                if (mutationGeneration !== uploadGeneration) {
                    pendingUpload = true
                    gistsyncform.warn(tradThis('Local data changed while preparing the upload. Please try again.'))
                    return
                }

                if (lockedProvider.getResourceId(lockedLocal)) {
                    // Keep a verified local recovery point of the exact remote
                    // value before an explicit overwrite. Downloading again
                    // here also closes the snapshot-building TOCTOU window.
                    const remoteBeforeUpload = await lockedProvider.download(lockedLocal)
                    assertValidRemoteMetadata(remoteBeforeUpload.metadata)
                    const normalizedRemote = normalizeExternalSync(remoteBeforeUpload.sync)
                    const lastSyncedAt = lockedProvider.getLastSyncedAt(lockedLocal)

                    if (
                        lastSyncedAt && isRemoteNewer(remoteBeforeUpload.metadata.updatedAt, lastSyncedAt) &&
                        !confirmRemoteOverwrite
                    ) {
                        confirmRemoteOverwrite = true
                        gistsyncform.warn(
                            tradThis('Remote data is newer than local. Click send again to overwrite remote.'),
                        )
                        return
                    }

                    await saveExternalConfigSnapshot(normalizedRemote as SyncSnapshot, 'before-remote-overwrite')
                }

                const result = await lockedProvider.upload(lockedLocal, latest)
                lastSyncedPayload = syncPayloadHash(latest)
                pendingUpload = mutationGeneration !== uploadGeneration
                confirmRemoteOverwrite = false
                startupFreshnessChecked = true
                clearSyncConflict()
                await recordRemoteSyncSuccess(lockedProvider, result, lastSyncedPayload)
                gistsyncform.accept()
            } catch (error) {
                gistsyncform.warn(error as string)
            } finally {
                releaseRemoteLock()
                releaseSyncLock()
            }
        }
    }

    if (update.gistToken === '') {
        await withSynchronizationLock(async () => {
            const current = await storage.local.get()
            current.gistToken = ''
            current.remoteResourceId = ''
            current.remoteLastSyncedAt = undefined
            stopAutomaticUpload()
            startupFreshnessChecked = true
            clearSyncConflict()
            await storage.local.remove('gistToken')
            for (const key of getRemoteProvider({ ...current, syncType: 'gist' })?.clearPatch() ?? []) {
                await storage.local.remove(key)
            }
            gistsyncform.accept()
            toggleSyncSettingsOption(current)
        })
        return
    }

    if (update.gistToken) {
        gistsyncform.load()

        try {
            await withSynchronizationLock(async () => {
                const current = await storage.local.get()
                const newToken = update.gistToken ?? ''
                const lookupState = { ...current, gistToken: newToken, syncType: 'gist' as const }
                const gist = getRemoteProvider(lookupState)

                if (!gist) throw new Error('Remote synchronization provider is unavailable')

                // Discovery lists the account's Gists. Some tokens can still read a
                // known Gist directly even when listing fails, so fall back to the
                // already-bound resource instead of rejecting a usable token.
                let foundId: string | undefined
                try {
                    foundId = await gist.findResource(lookupState)
                } catch (err) {
                    foundId = current.remoteResourceId || undefined
                    if (!foundId) throw err
                }

                await replaceRemoteIdentity(gist, newToken, foundId ?? '')
                current.gistToken = newToken
                current.remoteResourceId = foundId ?? ''
                current.remoteLastSyncedAt = undefined
                current.remoteLastFetchedAt = undefined
                current.lastSyncedPayload = undefined
                stopAutomaticUpload()
                startupFreshnessChecked = !needsStartupFreshnessCheck({ ...current, syncType: 'gist' })

                gistsyncform.accept()
                toggleSyncSettingsOption(current)
            })
        } catch (error) {
            gistsyncform.warn(error as string)
        }
    }

    if (isSyncType(update.type)) {
        await withSynchronizationLock(async () => {
            const current = await storage.local.get()
            current.syncType = update.type as SyncType
            if (current.syncType === 'off') stopAutomaticUpload()
            startupFreshnessChecked = !needsStartupFreshnessCheck(current)
            await storage.local.set({ syncType: current.syncType })
            toggleSyncSettingsOption(current)
        })
    }
}

async function replaceRemoteIdentity(
    provider: RemoteProvider,
    gistToken: string,
    remoteResourceId: string,
): Promise<void> {
    // Clear the old resource and baseline first. If any removal or the final
    // write fails, the previously configured identity is either untouched or
    // left without a resource/baseline, which is fail-closed. Persisting the
    // new identity before these removals creates a crash window where it can
    // inherit another account's baseline and overwrite its remote data.
    for (const key of provider.clearPatch()) {
        await storage.local.remove(key)
    }
    await storage.local.set({ gistToken, remoteResourceId })
}

function stopAutomaticUpload(): void {
    if (autoUploadTimer) clearTimeout(autoUploadTimer)
    autoUploadTimer = 0
    pendingUpload = false
    lastSyncedPayload = ''
    confirmRemoteOverwrite = false
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

    switch (type) {
        case 'off': {
            document.getElementById('gist-sync')?.classList.remove('shown')
            break
        }

        case 'gist': {
            document.getElementById('gist-sync')?.classList.add('shown')

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

async function applyDownloadedSync(_current: Sync, incoming: Partial<Sync>): Promise<Sync> {
    const next = normalizeExternalSync(incoming)

    await flushPendingDebounces()
    await storage.flushWrites()
    await storage.runExclusive(async (syncAccess) => {
        const latestCurrent = await syncAccess.get()
        const currentSnapshot = await buildBookmarkSnapshotFromConfig(latestCurrent)
        await saveExternalConfigSnapshot(currentSnapshot, 'before-sync-download')
        storage.stageSyncForReload(next)

        try {
            await replaceBookmarksFromConfig(currentSnapshot, next)
            await syncAccess.replace(next)
            storage.clearStagedSyncForReload()
        } catch (error) {
            try {
                storage.stageSyncForReload(latestCurrent)
                await replaceBookmarksFromConfig(next, currentSnapshot)
                await syncAccess.replace(latestCurrent)
                storage.clearStagedSyncForReload()
            } catch (rollbackError) {
                throw new AggregateError([error, rollbackError], 'Remote restore and automatic rollback both failed')
            }
            throw error
        }

        await resetBackgroundRuntimeCache(next.backgrounds).catch((err) => {
            console.warn('Downloaded background cache will be rebuilt after reload', err)
        })
    })

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

    if (!provider.getResourceId(local)) {
        return 'current'
    }

    // A bound resource without a local baseline can belong to a newly selected
    // account/resource in another tab. It is never safe to infer "current"
    // and PATCH it; the startup download/conflict flow must establish the
    // baseline first.
    if (!lastSyncedAt) return 'unknown'

    if (!isValidIsoTimestamp(lastSyncedAt)) return 'unknown'

    const remoteUpdatedAt = await provider.fetchUpdatedAt(local)

    if (!remoteUpdatedAt || !isValidIsoTimestamp(remoteUpdatedAt)) {
        return 'unknown'
    }

    return isRemoteNewer(remoteUpdatedAt, lastSyncedAt) ? 'newer' : 'current'
}

async function buildUploadSnapshot(data?: Sync): Promise<Sync> {
    await flushPendingDebounces()
    await waitForPendingBackgroundWrites()
    return await buildBookmarkSnapshotFromConfig(data ?? await storage.sync.get())
}

async function recordRemoteSyncSuccess(
    provider: RemoteProvider,
    metadata: RemoteMetadata,
    payload: string,
    fetchedAt?: string,
): Promise<void> {
    assertValidRemoteMetadata(metadata)
    await storage.local.set({
        ...provider.syncedPatch(metadata),
        ...(fetchedAt ? provider.fetchedPatch(fetchedAt) : {}),
        lastSyncedPayload: payload,
    })
    provider.setStatusNow(metadata)
}

function normalizeExternalSync(data: Partial<Sync>): Sync {
    removeDeprecatedFields(data as Sync)
    assertValidSyncInput(data)
    const links = data.links as Record<string, unknown> | undefined
    if (!links || !Array.isArray(links.folders) || !Array.isArray(links.favorites)) {
        throw new Error('Invalid remote configuration: bookmark snapshot is missing')
    }

    const normalized = mergeImportedConfig(structuredClone(SYNC_DEFAULT), data)
    assertValidNormalizedSync(normalized)
    return normalized
}

function assertValidRemoteMetadata(metadata: RemoteMetadata): void {
    if (!metadata.resourceId || !isValidIsoTimestamp(metadata.updatedAt)) {
        throw new Error('Invalid remote synchronization metadata')
    }
}

function isValidIsoTimestamp(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
        Number.isFinite(new Date(value).getTime())
}

function syncPayloadHash(data: Sync): string {
    const links = canonicalizeLinksForHash(data)
    const notes = data.notes ? { records: data.notes.records } : undefined
    return stableStringify({ ...data, links, notes })
}

function canonicalizeLinksForHash(data: Sync): Record<string, unknown> {
    const links = data.links as Sync['links'] & {
        folders?: Array<{ id: string; title: string; items: unknown[] }>
        favorites?: Array<{ id: string; title: string; url: string }>
        toolbarOrder?: string[]
    }
    const folders = links.folders ?? []
    const favorites = links.favorites ?? []
    const topLevel = new Map<string, unknown>([
        ...folders.map((folder) => [folder.id, canonicalFolder(folder)] as const),
        ...favorites.map((favorite) => [favorite.id, canonicalBookmark(favorite)] as const),
    ])
    const fallbackOrder = [...folders.map((folder) => folder.id), ...favorites.map((favorite) => favorite.id)]
    const order = links.toolbarOrder ?? fallbackOrder
    const toolbar = order.map((id) => topLevel.get(id)).filter((item) => item !== undefined)
    const { selectedFolder: _, toolbarOrder: _order, folders: _folders, favorites: _favorites, ...settings } = links

    return { ...settings, toolbar }
}

function canonicalFolder(folder: { title: string; items: unknown[] }): unknown {
    return {
        kind: 'folder',
        title: folder.title,
        items: folder.items.map(canonicalNode),
    }
}

function canonicalNode(node: unknown): unknown {
    const value = node as { title?: unknown; url?: unknown; items?: unknown }
    if (Array.isArray(value?.items)) {
        return canonicalFolder({ title: typeof value.title === 'string' ? value.title : '', items: value.items })
    }
    return canonicalBookmark(value)
}

function canonicalBookmark(bookmark: { title?: unknown; url?: unknown }): unknown {
    return {
        kind: 'bookmark',
        title: typeof bookmark.title === 'string' ? bookmark.title : '',
        url: typeof bookmark.url === 'string' ? bookmark.url : '',
    }
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
    replaceRemoteIdentity,
    resetSyncRuntimeForTests(payload = ''): void {
        if (autoUploadTimer) {
            clearTimeout(autoUploadTimer)
        }
        syncLocked = false
        autoUploadTimer = 0
        lastSyncedPayload = payload
        confirmRemoteOverwrite = false
        startupFreshnessChecked = true
        syncUiReady = false
        pendingUpload = false
        pendingConflictMessage = ''
    },
    startupPayloadDecision,
    syncPayloadHash,
}

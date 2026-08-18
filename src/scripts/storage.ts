import { LOCAL_DEFAULT, PLATFORM, SYNC_DEFAULT } from './defaults.ts'
import { deepEqual } from './dependencies/deepequal.ts'
import { normalizeLinksState } from './features/links/model.ts'
import { withConfigStorageLock } from './features/synchronization/lock.ts'
import { assertValidNormalizedSync, assertValidSyncInput } from './features/synchronization/validation.ts'
import { parse } from './utils/parse.ts'

import type { Local } from '../types/local.ts'
import type { Sync } from '../types/sync.ts'

type StorageType = 'localstorage' | 'webext-local'

interface AllStorage {
    sync?: Sync
    local?: Local
}

interface InitializedStorage {
    sync: Sync
    local: Local
}

interface StorageTypeReturn {
    init: () => StorageType
    get: () => StorageType
    set: (type: StorageType) => void
}

interface ExclusiveSyncAccess {
    clearAll: () => Promise<void>
    get: () => Promise<Sync>
    replace: (data: Sync) => Promise<void>
}

interface Storage {
    sync: {
        get: (key?: string | string[]) => Promise<Sync>
        set: (val: Partial<Sync>) => Promise<void>
        update: (mutator: (current: Sync) => void) => Promise<Sync>
        replace: (data: Sync) => Promise<void>
        remove: (key: string) => Promise<void>
        clear: () => Promise<void>
    }
    local: {
        get: (key?: keyof Local | (keyof Local)[]) => Promise<Local>
        set: (val: Partial<Local>) => Promise<void>
        remove: (key: keyof Local) => Promise<void>
        clear: () => Promise<void>
    }
    archive: {
        get: <T>(key: string) => Promise<T | undefined>
        set: <T>(key: string, value: T) => Promise<void>
        remove: (key: string) => Promise<void>
    }
    type: {
        get: () => StorageType
        set: (type: StorageType) => void
        init: () => StorageType
    }
    stageSyncForReload: (data: Sync) => void
    clearStagedSyncForReload: () => void
    flushWrites: () => Promise<void>
    runExclusive: <T>(operation: (access: ExclusiveSyncAccess) => Promise<T>) => Promise<T>
    init: () => Promise<InitializedStorage>
    clearall: () => Promise<void>
}

const SYNC_RELOAD_SNAPSHOT_KEY = 'bonjourr-sync-reload-snapshot'
const ARCHIVE_PREFIX = 'bonjourr-archive-'
const ARCHIVE_DATABASE = 'bonjourr-archives'
const ARCHIVE_STORE = 'archives'
const LOCAL_SECRET_DATABASE = 'bonjourr-local-secrets'
const LOCAL_SECRET_STORE = 'secrets'
const UNSPLASH_ACCESS_KEY = 'unsplashAccessKey'
const UNSPLASH_ACCESS_KEY_MIN_LENGTH = 16
const UNSPLASH_ACCESS_KEY_MAX_LENGTH = 256
const UNSPLASH_ACCESS_KEY_PATTERN = /^[A-Za-z0-9_-]+$/
let syncOperationQueue: Promise<void> = Promise.resolve()
let archiveOperationQueue: Promise<void> = Promise.resolve()
let archiveDatabasePromise: Promise<IDBDatabase> | undefined
let localSecretDatabasePromise: Promise<IDBDatabase> | undefined

// 之前所有写失败都被 try/catch 吞掉只 console.warn，用户毫无察觉。
// dispatch 一个事件让 settings 面板（或任何想监听的地方）显示个 banner。
// 触发场景：localStorage quota 满、存储权限被阻止等。
function reportStorageError(stage: string, err: unknown): void {
    console.warn(`[storage] ${stage} failed`, err)
    try {
        globalThis.dispatchEvent(
            new CustomEvent('bonjourr-storage-error', { detail: { stage, message: String(err) } }),
        )
    } catch (_) {
        // Reporting must never mask the original storage failure.
    }
}

export const storage: Storage = {
    sync: {
        get: syncGet,
        set: syncSet,
        update: syncUpdate,
        replace: syncReplace,
        remove: syncRemove,
        clear: syncClear,
    },
    local: {
        get: localGet,
        set: localSet,
        remove: localRemove,
        clear: localClear,
    },
    archive: {
        get: archiveGet,
        set: archiveSet,
        remove: archiveRemove,
    },
    stageSyncForReload,
    clearStagedSyncForReload,
    flushWrites: flushStorageWrites,
    runExclusive: runExclusiveStorageMutation,
    init: init,
    clearall: clearall,
    type: storageTypeFn(),
}

//	Storage type

function storageTypeFn(): StorageTypeReturn {
    let type: StorageType = 'webext-local'

    function get(): StorageType {
        return type
    }

    function init(): StorageType {
        if (globalThis.chrome?.storage === undefined) {
            type = 'localstorage'
            return 'localstorage'
        }

        return type
    }

    function set(newType: StorageType): void {
        type = newType
    }

    return { init, get, set }
}

//	Synced data

async function syncGet(_key?: string | string[]): Promise<Sync> {
    return await enqueueStorageOperation(syncGetNow)
}

async function syncGetNow(): Promise<Sync> {
    switch (storage.type.get()) {
        case 'webext-local': {
            const { syncStorage } = await chrome.storage.local.get('syncStorage') as unknown as Partial<Local>
            return verifyDataAsSync(syncStorage)
        }

        default: {
            return verifyDataAsSync(parse<Sync>(localStorage.bonjourr) ?? {})
        }
    }
}

function syncUpdate(mutator: (current: Sync) => void): Promise<Sync> {
    return enqueueStorageOperation(async () => {
        const previous = await syncGetNow()
        const next = structuredClone(previous)
        mutator(next)
        await syncReplaceNow(next)

        if (!deepEqual(previous, next)) {
            dispatchSyncWriteIfContentChanged(previous, next, changedTopLevelPatch(previous, next))
        }
        return next
    })
}

function changedTopLevelPatch(previous: Sync, next: Sync): Partial<Sync> {
    const patch: Partial<Sync> = {}
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
        if (!storageValuesEqual(previous[key], next[key])) patch[key] = next[key]
    }
    return patch
}

function storageValuesEqual(first: unknown, second: unknown): boolean {
    if (first === second) return true
    if (!first || !second || typeof first !== 'object' || typeof second !== 'object') return false
    return deepEqual(first as Record<string, unknown>, second as Record<string, unknown>)
}

function syncSet(keyval: Record<string, unknown>): Promise<void> {
    const sanitized = stripBookmarkMirrorFromPatch(keyval)

    return enqueueStorageOperation(() => syncSetNow(sanitized))
}

async function syncSetNow(sanitized: Record<string, unknown>): Promise<void> {
    switch (storage.type.get()) {
        case 'webext-local': {
            try {
                const local = await chrome.storage.local.get('syncStorage') as unknown as Partial<Local>
                const previous = verifyDataAsSync(local.syncStorage)
                const data = validateDataAsSync(mergeStoredValue(previous, sanitized) as Partial<Sync>)
                await chrome.storage.local.set({ syncStorage: data })
                dispatchSyncWriteIfContentChanged(previous, data, sanitized)
            } catch (err) {
                reportStorageError('sync-write', err)
                throw err
            }
            return
        }

        case 'localstorage': {
            if (typeof sanitized !== 'object') {
                return
            }

            try {
                const previous = verifyDataAsSync(parse<Sync>(localStorage.bonjourr) ?? {})
                const verified = validateDataAsSync(mergeStoredValue(previous, sanitized) as Partial<Sync>)
                localStorage.bonjourr = JSON.stringify(verified)
                globalThis.dispatchEvent(new Event('storage'))
                dispatchSyncWriteIfContentChanged(previous, verified, sanitized)
            } catch (err) {
                // QuotaExceededError / storage access blocked
                reportStorageError('sync-write', err)
                throw err
            }
            return
        }

        default:
    }
}

function syncReplace(data: Sync): Promise<void> {
    return enqueueStorageOperation(() => syncReplaceNow(data))
}

async function syncReplaceNow(data: Sync): Promise<void> {
    const sanitized = validateDataAsSync(structuredClone(data))

    try {
        switch (storage.type.get()) {
            case 'webext-local': {
                await chrome.storage.local.set({ syncStorage: sanitized })
                const { syncStorage } = await chrome.storage.local.get('syncStorage') as unknown as Partial<Local>

                if (!deepEqual(verifyDataAsSync(syncStorage), sanitized)) {
                    throw new Error('Sync replacement verification failed')
                }
                return
            }

            case 'localstorage': {
                localStorage.bonjourr = JSON.stringify(sanitized)
                const persisted = verifyDataAsSync(parse<Sync>(localStorage.bonjourr) ?? {})

                if (!deepEqual(persisted, sanitized)) {
                    throw new Error('Sync replacement verification failed')
                }
                globalThis.dispatchEvent(new Event('storage'))
                return
            }
        }
    } catch (err) {
        reportStorageError('sync-replace', err)
        throw err
    }
}

function dispatchSyncWriteIfContentChanged(
    previous: Partial<Sync> | undefined,
    next: Partial<Sync>,
    patch: Partial<Sync>,
): void {
    if (isOnlySelectedFolderChange(previous, next, patch)) {
        return
    }

    globalThis.dispatchEvent(new Event('bonjourr-sync-write'))
}

function isOnlySelectedFolderChange(
    previous: Partial<Sync> | undefined,
    next: Partial<Sync>,
    patch: Partial<Sync>,
): boolean {
    const keys = Object.keys(patch)

    if (keys.length !== 1 || !('links' in patch)) {
        return false
    }

    const previousLinks = previous?.links
    const nextLinks = next.links

    if (!previousLinks || !nextLinks) {
        return false
    }

    const { selectedFolder: _previousSelected, ...previousComparable } = previousLinks
    const { selectedFolder: _nextSelected, ...nextComparable } = nextLinks

    return deepEqual(previousComparable, nextComparable)
}

function syncRemove(key: string): Promise<void> {
    return enqueueStorageOperation(async () => {
        await syncRemoveNow(key)
    })
}

async function syncRemoveNow(key: string): Promise<void> {
    switch (storage.type.get()) {
        case 'webext-local': {
            try {
                const { syncStorage } = await chrome.storage.local.get('syncStorage') as unknown as Partial<Local>

                if (syncStorage) {
                    const data = verifyDataAsSync(syncStorage)
                    delete data[key]
                    await chrome.storage.local.set({ syncStorage: validateDataAsSync(data) })
                }
            } catch (err) {
                reportStorageError('sync-remove', err)
                throw err
            }
            return
        }

        case 'localstorage': {
            try {
                const data = verifyDataAsSync(parse<Sync>(localStorage.bonjourr) ?? {})
                delete data[key]
                localStorage.bonjourr = JSON.stringify(validateDataAsSync(data))
            } catch (err) {
                reportStorageError('sync-remove', err)
                throw err
            }
            return
        }

        default:
    }
}

function syncClear(): Promise<void> {
    return enqueueStorageOperation(syncClearNow)
}

async function syncClearNow(): Promise<void> {
    try {
        switch (storage.type.get()) {
            case 'webext-local': {
                await chrome.storage.local.remove('syncStorage')
                return
            }

            case 'localstorage': {
                localStorage.removeItem('bonjourr')
                return
            }

            default:
        }
    } catch (err) {
        reportStorageError('sync-clear', err)
        throw err
    }
}

function enqueueStorageOperation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = syncOperationQueue.catch(() => {}).then(() => withConfigStorageLock(operation))
    syncOperationQueue = queued.then(() => {}, () => {})
    return queued
}

async function flushStorageWrites(): Promise<void> {
    await syncOperationQueue
}

async function runExclusiveStorageMutation<T>(
    operation: (access: ExclusiveSyncAccess) => Promise<T>,
): Promise<T> {
    return await enqueueStorageOperation(() =>
        operation({
            clearAll: clearallNow,
            get: syncGetNow,
            replace: syncReplaceNow,
        })
    )
}

//	Local data

async function localSet(value: Partial<Local>): Promise<void> {
    const localValue = { ...value }
    const writesUnsplashAccessKey = Object.hasOwn(localValue, UNSPLASH_ACCESS_KEY)
    let unsplashAccessKey: string | undefined

    if (writesUnsplashAccessKey) {
        if (localValue.unsplashAccessKey !== undefined) {
            const candidate = localValue.unsplashAccessKey.trim()
            if (candidate !== '') {
                unsplashAccessKey = normalizeUnsplashAccessKey(candidate)
                if (!unsplashAccessKey) throw new TypeError('Invalid Unsplash Access Key')
            }
        }
        delete localValue.unsplashAccessKey
    }

    switch (storage.type.get()) {
        case 'webext-local': {
            try {
                if (writesUnsplashAccessKey) {
                    if (unsplashAccessKey) await chrome.storage.local.set({ [UNSPLASH_ACCESS_KEY]: unsplashAccessKey })
                    else await chrome.storage.local.remove(UNSPLASH_ACCESS_KEY)
                }
                if (Object.keys(localValue).length > 0) await chrome.storage.local.set(localValue)
            } catch (err) {
                reportStorageError('local-write', err)
                throw err
            }
            return
        }

        default: {
            try {
                if (writesUnsplashAccessKey) {
                    if (unsplashAccessKey) await localSecretSet(UNSPLASH_ACCESS_KEY, unsplashAccessKey)
                    else await localSecretRemove(UNSPLASH_ACCESS_KEY)
                }

                for (const [key, val] of Object.entries(localValue)) {
                    if (val === undefined) {
                        localStorage.removeItem(key)
                    } else if (typeof val === 'string') {
                        localStorage.setItem(key, val)
                    } else {
                        localStorage.setItem(key, JSON.stringify(val))
                    }
                }
            } catch (err) {
                reportStorageError('local-write', err)
                throw err
            }
            return
        }
    }
}

async function localGet(keys?: string | string[]): Promise<Local> {
    switch (storage.type.get()) {
        case 'webext-local': {
            const data = await chrome.storage.local.get(keys) as unknown
            return verifyDataAsLocal(data)
        }

        default: {
            const defaults = structuredClone(LOCAL_DEFAULT) as unknown
            const result: Record<string, unknown> = defaults as Record<string, unknown>

            if (keys === undefined) {
                keys = Object.keys(LOCAL_DEFAULT)
            }
            if (typeof keys === 'string') {
                keys = [keys]
            }

            const readsUnsplashAccessKey = keys.includes(UNSPLASH_ACCESS_KEY)

            const localKeys = Object.keys(globalThis.localStorage)
            const neededKeys = keys.filter((k) => k !== UNSPLASH_ACCESS_KEY && localKeys.includes(k))

            for (const key of neededKeys) {
                const item = globalThis.localStorage.getItem(key)
                if (key === 'lastSyncedPayload') {
                    result[key] = item
                    continue
                }
                const isJson = item && (item.startsWith('{') || item.startsWith('['))
                const isBool = item && (item === 'true' || item === 'false')

                if (isJson) {
                    result[key] = parse(item)
                } else if (isBool) {
                    result[key] = item === 'true'
                } else if (item === 'undefined') {
                    localStorage.removeItem(key)
                } else {
                    result[key] = item
                }
            }

            if (readsUnsplashAccessKey) {
                try {
                    const accessKey = await localSecretGet(UNSPLASH_ACCESS_KEY)
                    if (accessKey) result.unsplashAccessKey = accessKey
                } catch (err) {
                    // The key is optional. A blocked IndexedDB database must
                    // not prevent the rest of the new-tab page from starting.
                    reportStorageError('local-secret-read', err)
                }
            }

            return verifyDataAsLocal(result)
        }
    }
}

async function localRemove(key: string): Promise<void> {
    switch (storage.type.get()) {
        case 'webext-local': {
            try {
                await chrome.storage.local.remove(key)
            } catch (err) {
                reportStorageError('local-remove', err)
                throw err
            }
            return
        }

        case 'localstorage': {
            try {
                if (key === UNSPLASH_ACCESS_KEY) await localSecretRemove(key)
                else localStorage.removeItem(key)
            } catch (err) {
                reportStorageError('local-remove', err)
                throw err
            }
            return
        }

        default: {
            return
        }
    }
}

async function localClear(): Promise<void> {
    switch (storage.type.get()) {
        case 'webext-local': {
            try {
                const current = await chrome.storage.local.get()
                const localKeys = Object.keys(current).filter((key) =>
                    key !== 'syncStorage' && !key.startsWith(ARCHIVE_PREFIX)
                )
                if (localKeys.length > 0) {
                    await chrome.storage.local.remove(localKeys)
                }
            } catch (err) {
                reportStorageError('local-clear', err)
                throw err
            }
            return
        }

        case 'localstorage': {
            try {
                for (const key of Object.keys(LOCAL_DEFAULT)) {
                    localStorage.removeItem(key)
                }
                await localSecretRemove(UNSPLASH_ACCESS_KEY)
            } catch (err) {
                reportStorageError('local-clear', err)
                throw err
            }
            return
        }

        default:
    }
}

async function localSecretGet(key: typeof UNSPLASH_ACCESS_KEY): Promise<string | undefined> {
    if (!globalThis.indexedDB) return

    const database = await openLocalSecretDatabase()
    const transaction = database.transaction(LOCAL_SECRET_STORE, 'readonly')
    const completed = idbTransaction(transaction)
    const request = transaction.objectStore(LOCAL_SECRET_STORE).get(key)
    let value: unknown
    request.onsuccess = () => {
        value = request.result
    }
    await completed
    return normalizeUnsplashAccessKey(value)
}

async function localSecretSet(key: typeof UNSPLASH_ACCESS_KEY, value: string): Promise<void> {
    if (!globalThis.indexedDB) throw new Error('Secure local storage is unavailable')

    const database = await openLocalSecretDatabase()
    const transaction = database.transaction(LOCAL_SECRET_STORE, 'readwrite')
    const completed = idbTransaction(transaction)
    transaction.objectStore(LOCAL_SECRET_STORE).put(value, key)
    await completed

    if (await localSecretGet(key) !== value) {
        throw new Error('Secure local storage verification failed')
    }
}

async function localSecretRemove(key: typeof UNSPLASH_ACCESS_KEY): Promise<void> {
    if (!globalThis.indexedDB) return

    const database = await openLocalSecretDatabase()
    const transaction = database.transaction(LOCAL_SECRET_STORE, 'readwrite')
    const completed = idbTransaction(transaction)
    transaction.objectStore(LOCAL_SECRET_STORE).delete(key)
    await completed
}

function openLocalSecretDatabase(): Promise<IDBDatabase> {
    if (localSecretDatabasePromise) return localSecretDatabasePromise

    localSecretDatabasePromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(LOCAL_SECRET_DATABASE, 1)
        let settled = false
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(LOCAL_SECRET_STORE)) {
                request.result.createObjectStore(LOCAL_SECRET_STORE)
            }
        }
        request.onsuccess = () => {
            const database = request.result
            if (settled) {
                database.close()
                return
            }
            settled = true
            database.onversionchange = () => {
                database.close()
                localSecretDatabasePromise = undefined
            }
            resolve(database)
        }
        request.onerror = () => {
            if (settled) return
            settled = true
            localSecretDatabasePromise = undefined
            reject(request.error ?? new Error('Secure local storage could not be opened'))
        }
        request.onblocked = () => {
            if (settled) return
            settled = true
            localSecretDatabasePromise = undefined
            reject(new Error('Secure local storage upgrade is blocked'))
        }
    })

    return localSecretDatabasePromise
}

// Durable recovery archives. Extension builds keep these values in their own
// chrome.storage.local keys so startup config reads and localStorage quotas do
// not constrain large bookmark snapshots.

function archiveGet<T>(key: string): Promise<T | undefined> {
    assertArchiveKey(key)
    return enqueueArchiveOperation(() => archiveGetNow<T>(key))
}

async function archiveGetNow<T>(key: string): Promise<T | undefined> {
    try {
        if (storage.type.get() === 'webext-local') {
            const result = await chrome.storage.local.get(key) as Record<string, unknown>
            if (key in result) return structuredClone(result[key]) as T

            // One-time migration from releases that stored recovery snapshots
            // in the extension page's localStorage.
            const legacy = parse<T>(localStorage.getItem(key) ?? '')
            if (legacy !== undefined) {
                await archiveSetNow(key, legacy)
                localStorage.removeItem(key)
                return structuredClone(legacy)
            }
            return
        }

        if (globalThis.indexedDB) {
            const stored = await indexedDbArchiveGet<T>(key)
            if (stored !== undefined) return stored

            const legacy = parse<T>(localStorage.getItem(key) ?? '')
            if (legacy !== undefined) {
                await indexedDbArchiveSet(key, legacy)
                localStorage.removeItem(key)
                return structuredClone(legacy)
            }
            return
        }

        return parse<T>(localStorage.getItem(key) ?? '')
    } catch (err) {
        reportStorageError('archive-read', err)
        throw err
    }
}

function archiveSet<T>(key: string, value: T): Promise<void> {
    assertArchiveKey(key)
    return enqueueArchiveOperation(() => archiveSetNow(key, value))
}

async function archiveSetNow<T>(key: string, value: T): Promise<void> {
    try {
        const cloned = structuredClone(value)
        if (storage.type.get() === 'webext-local') {
            await chrome.storage.local.set({ [key]: cloned })
            const written = await chrome.storage.local.get(key) as Record<string, unknown>
            if (!storageValuesEqual(written[key], cloned)) {
                throw new Error('Archive write verification failed')
            }
            return
        }

        if (globalThis.indexedDB) {
            await indexedDbArchiveSet(key, cloned)
            const written = await indexedDbArchiveGet<T>(key)
            if (!storageValuesEqual(written, cloned)) {
                throw new Error('Archive write verification failed')
            }
            return
        }

        const serialized = JSON.stringify(cloned)
        localStorage.setItem(key, serialized)
        if (localStorage.getItem(key) !== serialized) {
            throw new Error('Archive write verification failed')
        }
    } catch (err) {
        reportStorageError('archive-write', err)
        throw err
    }
}

function archiveRemove(key: string): Promise<void> {
    assertArchiveKey(key)
    return enqueueArchiveOperation(async () => {
        try {
            if (storage.type.get() === 'webext-local') {
                await chrome.storage.local.remove(key)
            } else if (globalThis.indexedDB) {
                await indexedDbArchiveRemove(key)
                localStorage.removeItem(key)
            } else {
                localStorage.removeItem(key)
            }
        } catch (err) {
            reportStorageError('archive-remove', err)
            throw err
        }
    })
}

async function indexedDbArchiveGet<T>(key: string): Promise<T | undefined> {
    const database = await openArchiveDatabase()
    const transaction = database.transaction(ARCHIVE_STORE, 'readonly')
    const completed = idbTransaction(transaction)
    const request = transaction.objectStore(ARCHIVE_STORE).get(key)
    let value: unknown
    request.onsuccess = () => {
        value = request.result
    }
    await completed
    return value === undefined ? undefined : structuredClone(value) as T
}

async function indexedDbArchiveSet<T>(key: string, value: T): Promise<void> {
    const database = await openArchiveDatabase()
    const transaction = database.transaction(ARCHIVE_STORE, 'readwrite')
    const completed = idbTransaction(transaction)
    transaction.objectStore(ARCHIVE_STORE).put(structuredClone(value), key)
    await completed
}

async function indexedDbArchiveRemove(key: string): Promise<void> {
    const database = await openArchiveDatabase()
    const transaction = database.transaction(ARCHIVE_STORE, 'readwrite')
    const completed = idbTransaction(transaction)
    transaction.objectStore(ARCHIVE_STORE).delete(key)
    await completed
}

function openArchiveDatabase(): Promise<IDBDatabase> {
    if (archiveDatabasePromise) return archiveDatabasePromise

    archiveDatabasePromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(ARCHIVE_DATABASE, 1)
        let settled = false
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(ARCHIVE_STORE)) {
                request.result.createObjectStore(ARCHIVE_STORE)
            }
        }
        request.onsuccess = () => {
            const database = request.result
            if (settled) {
                database.close()
                return
            }
            settled = true
            database.onversionchange = () => {
                database.close()
                archiveDatabasePromise = undefined
            }
            resolve(database)
        }
        request.onerror = () => {
            if (settled) return
            settled = true
            archiveDatabasePromise = undefined
            reject(request.error ?? new Error('Archive database could not be opened'))
        }
        request.onblocked = () => {
            if (settled) return
            settled = true
            archiveDatabasePromise = undefined
            reject(new Error('Archive database upgrade is blocked'))
        }
    })

    return archiveDatabasePromise
}

function idbTransaction(transaction: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    })
}

function enqueueArchiveOperation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = archiveOperationQueue.catch(() => {}).then(operation)
    archiveOperationQueue = queued.then(() => {}, () => {})
    return queued
}

function assertArchiveKey(key: string): void {
    if (!key.startsWith(ARCHIVE_PREFIX)) {
        throw new Error('Archive keys must use the reserved archive prefix')
    }
}

//	Init data

async function init(): Promise<InitializedStorage> {
    const store = globalThis.startupStorage as AllStorage ?? {}

    if (PLATFORM !== 'online' && !webextStoreReady()) {
        globalThis.pageReady = true

        await waitForStartupStorage(store)
    }

    const type = storage.type.init()

    switch (type) {
        case 'webext-local': {
            const localData = store.local ?? (globalThis.startupStorage as AllStorage)?.local ?? {} as Local
            store.local = localData as Local
            // The injected startup snapshot is only a paint/startup hint. It
            // may have been captured before another tab committed a restore or
            // settings write, so always refresh config through the same
            // cross-context lock used by every normal sync operation.
            store.sync = await syncGet()
            store.local.syncStorage = store.sync
            break
        }

        case 'localstorage': {
            store.sync = await syncGet()
            store.local = await localGet()
            break
        }

        default:
    }

    const stagedSync = readStagedSyncForReload()
    if (stagedSync) {
        // This journal is written before bookmarks are changed so quota and
        // serialization failures stop the destructive operation early. It is
        // not proof that bookmark mutation or config commit completed. Never
        // replay it on startup: doing so could overwrite a newer write from
        // another tab, or apply target config after a crash that happened
        // before bookmarks changed. Durable recovery snapshots handle repair.
        clearStagedSyncForReload()
    }

    if (Object.keys(store.sync ?? {})?.length === 0) {
        store.sync = structuredClone(SYNC_DEFAULT)
    }

    const sync = verifyDataAsSync(store.sync)
    normalizeLinksState(sync)
    const local = verifyDataAsLocal(store.local)

    return {
        sync,
        local,
    }

    /** This waits for chrome.storage to be stored in a global variable,
		that is created in file `webext-storage.js` */
    function webextStoreReady(): boolean {
        return !!store.local
    }
}

//	Clear all data

function clearall(): Promise<void> {
    return enqueueStorageOperation(clearallNow)
}

async function clearallNow(): Promise<void> {
    switch (storage.type.get()) {
        case 'webext-local': {
            // Recovery archives survive a reset so a fatal settings corruption
            // can always be rolled back from the settings panel.
            try {
                const current = await chrome.storage.local.get() as Record<string, unknown>
                const archives = Object.fromEntries(
                    Object.entries(current).filter(([key]) => key.startsWith(ARCHIVE_PREFIX)),
                )
                const resetState: Record<string, unknown> = {
                    ...archives,
                    ...LOCAL_DEFAULT,
                    syncStorage: structuredClone(SYNC_DEFAULT),
                }

                // Write the complete safe state before removing stale keys. A
                // failed write therefore leaves the old state intact instead
                // of clearing it first and losing everything.
                await chrome.storage.local.set(resetState)
                const obsoleteKeys = Object.keys(current).filter((key) => !(key in resetState))
                if (obsoleteKeys.length > 0) await chrome.storage.local.remove(obsoleteKeys)

                const readback = await chrome.storage.local.get('syncStorage') as unknown as Local
                if (!deepEqual(verifyDataAsSync(readback.syncStorage), SYNC_DEFAULT)) {
                    throw new Error('Reset verification failed')
                }
            } catch (err) {
                reportStorageError('clear-all', err)
                throw err
            }
            break
        }

        case 'localstorage': {
            try {
                localStorage.setItem('bonjourr', JSON.stringify(SYNC_DEFAULT))
                if (!deepEqual(verifyDataAsSync(parse<Sync>(localStorage.bonjourr) ?? {}), SYNC_DEFAULT)) {
                    throw new Error('Reset verification failed')
                }
                await localSecretRemove(UNSPLASH_ACCESS_KEY)
            } catch (err) {
                reportStorageError('clear-all', err)
                throw err
            }
            break
        }
    }

    sessionStorage.clear()
    for (const key of Object.keys(localStorage)) {
        const preserve = key === 'bonjourr' || key === 'update-archive' || key.startsWith('bonjourr-archive-')
        if (!preserve) localStorage.removeItem(key)
    }

    //@ts-expect-error: Type 'undefined' is not assignable to type ...
    globalThis.startupStorage = undefined
    globalThis.startupBookmarks = undefined
}

//	Helpers

export function isStorageDefault(data: Sync): boolean {
    return deepEqual(data, SYNC_DEFAULT)
}

export function normalizeUnsplashAccessKey(value: unknown): string | undefined {
    if (typeof value !== 'string') return

    const accessKey = value.trim()
    const validLength = accessKey.length >= UNSPLASH_ACCESS_KEY_MIN_LENGTH &&
        accessKey.length <= UNSPLASH_ACCESS_KEY_MAX_LENGTH
    return validLength && UNSPLASH_ACCESS_KEY_PATTERN.test(accessKey) ? accessKey : undefined
}

function verifyDataAsSync(data: Partial<Sync> = {}): Sync {
    return normalizeDataAsSync(data, false)
}

function validateDataAsSync(data: Partial<Sync> = {}): Sync {
    return normalizeDataAsSync(data, true)
}

function normalizeDataAsSync(data: Partial<Sync>, rejectInvalid: boolean): Sync {
    const sync = structuredClone(SYNC_DEFAULT) as Sync & Record<string, unknown>
    const source = isRecord(data) ? data : {}

    // Sync has an index signature for legacy call sites, but persisted config
    // must contain only the current schema. In particular, provider tokens and
    // local synchronization metadata must never leak into exports or Remote.
    for (const key of Object.keys(SYNC_DEFAULT)) {
        if (!(key in source)) continue

        try {
            // Validate each top-level branch independently. One corrupted
            // setting must not make startup discard every other valid field.
            assertValidSyncInput({ [key]: source[key] })
            sync[key] = mergeStoredValue(sync[key], source[key])
        } catch (err) {
            if (rejectInvalid) throw err
            console.warn(`[storage] Ignoring invalid persisted setting: ${key}`, err)
        }
    }
    stripBookmarkMirrorFromLinks(sync.links)
    normalizeLinksState(sync)
    try {
        assertValidNormalizedSync(sync)
    } catch (err) {
        if (rejectInvalid) throw err
        console.warn('[storage] Persisted configuration required recovery', err)
    }
    return sync
}

function mergeStoredValue(fallback: unknown, stored: unknown): unknown {
    if (Array.isArray(fallback)) return structuredClone(stored)
    if (!isRecord(fallback) || !isRecord(stored)) return structuredClone(stored)

    const result: Record<string, unknown> = structuredClone(fallback)
    for (const [key, value] of Object.entries(stored)) {
        result[key] = key in result ? mergeStoredValue(result[key], value) : structuredClone(value)
    }
    return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function verifyDataAsLocal(data: unknown = {}): Local {
    const local = structuredClone(LOCAL_DEFAULT)
    if (!isRecord(data)) return local

    for (
        const key of [
            'gistToken',
            'remoteResourceId',
            'remoteLastSyncedAt',
            'remoteLastFetchedAt',
            'localConfigUpdatedAt',
            'lastSyncedPayload',
            'backgroundLastChange',
            'backgroundLastTrackedPhoto',
            'fontface',
        ] as const
    ) {
        if (typeof data[key] === 'string') local[key] = data[key]
    }

    const unsplashAccessKey = normalizeUnsplashAccessKey(data.unsplashAccessKey)
    if (unsplashAccessKey) local.unsplashAccessKey = unsplashAccessKey

    if (data.syncType === 'off' || data.syncType === 'gist') local.syncType = data.syncType
    if (data.operaExplained === true) local.operaExplained = true
    if (isValidTranslations(data.translations)) local.translations = structuredClone(data.translations)
    if (Array.isArray(data.fonts)) local.fonts = structuredClone(data.fonts) as Local['fonts']
    if (isRecord(data.syncStorage)) local.syncStorage = verifyDataAsSync(data.syncStorage)

    local.backgroundCollections = sanitizeBackgroundCollections(data.backgroundCollections)
    return local
}

function isValidTranslations(value: unknown): value is NonNullable<Local['translations']> {
    return isRecord(value) && typeof value.lang === 'string' &&
        Object.values(value).every((entry) => typeof entry === 'string')
}

function sanitizeBackgroundCollections(value: unknown): Local['backgroundCollections'] {
    if (!isRecord(value)) return {}
    const result: Local['backgroundCollections'] = {}

    for (const [key, collection] of Object.entries(value)) {
        if (Array.isArray(collection) && collection.every(isLocalBackgroundImage)) {
            result[key] = structuredClone(collection)
        }
    }
    return result
}

function isLocalBackgroundImage(value: unknown): boolean {
    return isRecord(value) && value.format === 'image' && isRecord(value.urls) &&
        typeof value.urls.full === 'string' && typeof value.urls.small === 'string'
}

function stageSyncForReload(data: Sync): void {
    try {
        const serialized = JSON.stringify(validateDataAsSync(structuredClone(data)))
        sessionStorage.setItem(SYNC_RELOAD_SNAPSHOT_KEY, serialized)
        if (sessionStorage.getItem(SYNC_RELOAD_SNAPSHOT_KEY) !== serialized) {
            throw new Error('Sync reload snapshot verification failed')
        }
    } catch (err) {
        reportStorageError('sync-reload-stage', err)
        throw err
    }
}

function readStagedSyncForReload(): Sync | undefined {
    let raw: string | null

    try {
        raw = sessionStorage.getItem(SYNC_RELOAD_SNAPSHOT_KEY)
    } catch (err) {
        reportStorageError('sync-reload-read', err)
        return
    }

    if (!raw) {
        return
    }

    const parsed = parse<Partial<Sync>>(raw)

    if (!parsed || Object.keys(parsed).length === 0) {
        try {
            clearStagedSyncForReload()
        } catch (_) {
            // readStagedSyncForReload remains best effort during startup.
        }
        return
    }

    return verifyDataAsSync(parsed)
}

function clearStagedSyncForReload(): void {
    try {
        sessionStorage.removeItem(SYNC_RELOAD_SNAPSHOT_KEY)
    } catch (err) {
        reportStorageError('sync-reload-clear', err)
        throw err
    }
}

function stripBookmarkMirrorFromPatch(keyval: Record<string, unknown>): Record<string, unknown> {
    if (!('links' in keyval)) {
        return keyval
    }

    const links = keyval.links

    if (!links || typeof links !== 'object' || Array.isArray(links)) {
        return keyval
    }

    const next = { ...keyval }
    next.links = { ...(links as Record<string, unknown>) }
    stripBookmarkMirrorFromLinks(next.links as Sync['links'])
    return next
}

function stripBookmarkMirrorFromLinks(links: Sync['links']): void {
    const bookmarkLinks = links as Sync['links'] & { folders?: unknown; favorites?: unknown; toolbarOrder?: unknown }
    delete bookmarkLinks.folders
    delete bookmarkLinks.favorites
    delete bookmarkLinks.toolbarOrder
}

const STARTUP_STORAGE_EVENT_TIMEOUT_MS = 1500
const STARTUP_STORAGE_READ_TIMEOUT_MS = 3000

async function waitForStartupStorage(store: AllStorage): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let onReady: (() => void) | undefined

    try {
        await new Promise<void>((resolve) => {
            const finish = (): void => {
                if (timeout !== undefined) {
                    clearTimeout(timeout)
                }
                if (onReady) {
                    document.removeEventListener('webextstorage', onReady)
                }
                resolve()
            }

            onReady = () => {
                store.local = globalThis.startupStorage?.local as Local | undefined
                store.sync = globalThis.startupStorage?.sync as Sync | undefined
                if (store.local) {
                    finish()
                }
            }

            document.addEventListener('webextstorage', onReady)
            timeout = setTimeout(finish, STARTUP_STORAGE_EVENT_TIMEOUT_MS)
        })

        if (!store.local) {
            const data = await withTimeout(
                chrome.storage.local.get(),
                STARTUP_STORAGE_READ_TIMEOUT_MS,
                'Extension storage startup read timed out',
            )
            const local = data as unknown as Local
            store.local = local
            store.sync = local.syncStorage
        }
    } catch (err) {
        reportStorageError('startup-read', err)
        throw err
    } finally {
        if (timeout !== undefined) {
            clearTimeout(timeout)
        }
        if (onReady) {
            document.removeEventListener('webextstorage', onReady)
        }
    }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
    })

    try {
        return await Promise.race([operation, timeoutPromise])
    } finally {
        if (timeout !== undefined) {
            clearTimeout(timeout)
        }
    }
}

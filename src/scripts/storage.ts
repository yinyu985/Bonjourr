import { LOCAL_DEFAULT, PLATFORM, SYNC_DEFAULT } from './defaults.ts'
import { deepEqual } from './dependencies/deepequal.ts'
import { parse } from './utils/parse.ts'

import type { Local } from '../types/local.ts'
import type { Sync } from '../types/sync.ts'

type StorageType = 'localstorage' | 'webext-local'

interface AllStorage {
    sync?: Sync
    local?: Local
}

interface StorageTypeReturn {
    init: () => StorageType
    get: () => StorageType
    set: (type: StorageType) => void
}

interface Storage {
    sync: {
        get: (key?: string | string[]) => Promise<Sync>
        set: (val: Partial<Sync>) => Promise<void>
        remove: (key: string) => void
        clear: () => Promise<void>
    }
    local: {
        get: (key?: keyof Local | (keyof Local)[]) => Promise<Local>
        set: (val: Partial<Local>) => void
        remove: (key: keyof Local) => void
        clear: () => void
    }
    type: {
        get: () => StorageType
        set: (type: StorageType) => void
        init: () => StorageType
    }
    init: () => Promise<AllStorage>
    clearall: () => Promise<void>
}

export const storage: Storage = {
    sync: {
        get: syncGet,
        set: syncSet,
        remove: syncRemove,
        clear: syncClear,
    },
    local: {
        get: localGet,
        set: localSet,
        remove: localRemove,
        clear: localClear,
    },
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
    switch (storage.type.get()) {
        case 'webext-local': {
            const { syncStorage } = await chrome.storage.local.get() as Local
            return verifyDataAsSync(syncStorage)
        }

        default: {
            return verifyDataAsSync(parse<Sync>(localStorage.bonjourr) ?? {})
        }
    }
}

async function syncSet(keyval: Record<string, unknown>, fn = () => {}): Promise<void> {
    // console.log('sync set', JSON.stringify(keyval))

    switch (storage.type.get()) {
        case 'webext-local': {
            try {
                const local = await chrome.storage.local.get('syncStorage') as Local
                const data = {
                    ...local.syncStorage,
                    ...keyval,
                }
                await chrome.storage.local.set({ syncStorage: data })
            } catch (err) {
                console.warn('Local storage write failed', err)
            }
            fn()
            return
        }

        case 'localstorage': {
            if (typeof keyval !== 'object') {
                return
            }

            const data = verifyDataAsSync(parse<Sync>(localStorage.bonjourr) ?? {})

            for (const [k, v] of Object.entries(keyval)) {
                data[k] = v
            }

            localStorage.bonjourr = JSON.stringify(data ?? {})
            globalThis.dispatchEvent(new Event('storage'))
            return
        }

        default:
    }
}

async function syncRemove(key: string): Promise<void> {
    switch (storage.type.get()) {
        case 'webext-local': {
            try {
                const { syncStorage } = await chrome.storage.local.get('syncStorage') as Local

                if (syncStorage) {
                    delete syncStorage[key]
                    await chrome.storage.local.remove('syncStorage')
                    await chrome.storage.local.set({ syncStorage })
                }
            } catch (_) { /* ignore */ }
            return
        }

        case 'localstorage': {
            const data = parse<Record<string, unknown>>(localStorage.bonjourr) ?? {}
            delete data[key]
            localStorage.bonjourr = JSON.stringify(data)
            return
        }

        default:
    }
}

async function syncClear(): Promise<void> {
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
}

//	Local data

function localSet(value: Record<string, unknown>): void {
    // console.log('local set', JSON.stringify(value))

    switch (storage.type.get()) {
        case 'webext-local': {
            chrome.storage.local.set(value).catch((err) => {
                console.warn('Local storage write failed', err)
            })
            return
        }

        default: {
            for (const [key, val] of Object.entries(value)) {
                if (val === undefined) {
                    localStorage.removeItem(key)
                } else if (typeof val === 'string') {
                    localStorage.setItem(key, val)
                } else {
                    localStorage.setItem(key, JSON.stringify(val))
                }
            }
            return
        }
    }
}

async function localGet(keys?: string | string[]): Promise<Local> {
    switch (storage.type.get()) {
        case 'webext-local': {
            const data = await chrome.storage.local.get(keys) as unknown as Local
            return data
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

            const localKeys = Object.keys(globalThis.localStorage)
            const neededKeys = keys.filter((k) => localKeys.includes(k))

            for (const key of neededKeys) {
                const item = globalThis.localStorage.getItem(key)
                const isJson = item && (item.startsWith('{') || item.startsWith('['))
                const isBool = item && (item === 'true' || item === 'false')
                const isNoom = item && Number.isNaN(Number(item)) === false

                if (isJson) {
                    result[key] = parse(item)
                } else if (isBool) {
                    result[key] = item === 'true'
                } else if (isNoom) {
                    result[key] = Number.parseFloat(item)
                } else if (item === 'undefined') {
                    localStorage.removeItem(key)
                } else {
                    result[key] = item
                }
            }

            return result as unknown as Local
        }
    }
}

function localRemove(key: string): Promise<void> {
    switch (storage.type.get()) {
        case 'webext-local': {
            return chrome.storage.local.remove(key).catch(() => {})
        }

        case 'localstorage': {
            localStorage.removeItem(key)
            return Promise.resolve()
        }

        default: {
            return Promise.resolve()
        }
    }
}

async function localClear(): Promise<void> {
    switch (storage.type.get()) {
        case 'webext-local': {
            try {
                const sync = (await chrome.storage.local.get('syncStorage')).syncStorage
                await chrome.storage.local.clear()
                await chrome.storage.local.set({ syncStorage: sync })
            } catch (_) { /* ignore */ }
            return
        }

        case 'localstorage': {
            for (const key of Object.keys(LOCAL_DEFAULT)) {
                localStorage.removeItem(key)
            }
            return
        }

        default:
    }
}

//	Init data

async function init(): Promise<AllStorage> {
    const store = globalThis.startupStorage as AllStorage ?? {}

    if (PLATFORM !== 'online' && !webextStoreReady()) {
        globalThis.pageReady = true

        await new Promise((resolve) => {
            document.addEventListener('webextstorage', () => {
                store.local = globalThis.startupStorage.local as Local
                store.sync = globalThis.startupStorage.sync as Sync
                if (webextStoreReady()) {
                    resolve(true)
                }
            })
        })
    }

    const type = storage.type.init()

    switch (type) {
        case 'webext-local': {
            const localData = store.local ?? (globalThis.startupStorage as AllStorage)?.local ?? {} as Local
            store.sync = (localData as Local).syncStorage
            store.local = localData as Local
            break
        }

        case 'localstorage': {
            store.sync = await syncGet()
            store.local = await localGet()
            break
        }

        default:
    }

    if (Object.keys(store.sync ?? {})?.length === 0) {
        store.sync = await getSyncDefaults()
    }

    const sync = verifyDataAsSync(store.sync)
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

async function clearall(): Promise<void> {
    sessionStorage.clear()

    Object.keys(localStorage).forEach((key) => {
        if (key.startsWith('bonjourr-archive-') === false) {
            localStorage.removeItem(key)
        }
    })

    try {
        globalThis.caches.delete('local-files')
    } catch (err) {
        console.warn(err)
    }

    //@ts-expect-error: Type 'undefined' is not assignable to type ...
    globalThis.startupStorage = undefined
    globalThis.startupBookmarks = undefined

    switch (storage.type.get()) {
        case 'webext-local': {
            try {
                await chrome.storage.sync.clear()
            } catch (_) { /* ignore */ }
            try {
                await chrome.storage.local.clear()
            } catch (_) { /* ignore */ }
            try {
                await chrome.storage.local.set({
                    ...LOCAL_DEFAULT,
                    syncStorage: SYNC_DEFAULT,
                })
            } catch (_) { /* ignore */ }
            return
        }

        default:
    }
}

//	Helpers

export async function getSyncDefaults(): Promise<Sync> {
    try {
        const json = await (await fetch('config.json')).json()
        return verifyDataAsSync(json)
    } catch (_) {
        // ...
    }

    return SYNC_DEFAULT
}

export function isStorageDefault(data: Sync): boolean {
    const current = structuredClone(data)
    current.review = SYNC_DEFAULT.review
    current.showall = SYNC_DEFAULT.showall

    return deepEqual(current, SYNC_DEFAULT)
}

function verifyDataAsSync(data: Partial<Sync> = {}): Sync {
    return {
        ...SYNC_DEFAULT,
        ...data,
    }
}

function verifyDataAsLocal(data: Partial<Local> = {}): Local {
    //@ts-ignore -> `x-icon-${string}` index signatures are incompatible.
    return {
        ...LOCAL_DEFAULT,
        ...data,
    }
}

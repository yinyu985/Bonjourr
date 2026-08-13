import './init.test.ts'

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert'
import { LOCAL_DEFAULT, SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import { normalizeUnsplashAccessKey, storage } from '../src/scripts/storage.ts'

const VALID_ACCESS_KEY = 'Abcdefghijklmnop_1234567890-safe'

interface IndexedDbMock {
    state: Map<string, unknown>
    restore: () => void
}

function installWebextStorage(initial: Record<string, unknown> = {}): {
    state: Record<string, unknown>
    restore: () => void
} {
    const previous = globalThis.chrome
    const state = structuredClone(initial)
    const local = {
        get(keys?: string | string[]): Promise<Record<string, unknown>> {
            if (typeof keys === 'string') {
                return Promise.resolve(keys in state ? { [keys]: structuredClone(state[keys]) } : {})
            }
            if (Array.isArray(keys)) {
                return Promise.resolve(
                    Object.fromEntries(
                        keys.filter((key) => key in state).map((key) => [key, structuredClone(state[key])]),
                    ),
                )
            }
            return Promise.resolve(structuredClone(state))
        },
        set(value: Record<string, unknown>): Promise<void> {
            Object.assign(state, structuredClone(value))
            return Promise.resolve()
        },
        remove(keys: string | string[]): Promise<void> {
            for (const key of typeof keys === 'string' ? [keys] : keys) delete state[key]
            return Promise.resolve()
        },
    } as unknown as typeof chrome.storage.local

    Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        writable: true,
        value: { ...previous, storage: { local } } as typeof chrome,
    })
    storage.type.set('webext-local')

    return {
        state,
        restore: () => {
            Object.defineProperty(globalThis, 'chrome', {
                configurable: true,
                writable: true,
                value: previous,
            })
            storage.type.set('localstorage')
        },
    }
}

function installIndexedDbMock(): IndexedDbMock {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
    const state = new Map<string, unknown>()
    let storeCreated = false

    const database = {
        onversionchange: null,
        objectStoreNames: {
            contains: (name: string): boolean => storeCreated && name === 'secrets',
        },
        createObjectStore: (): IDBObjectStore => {
            storeCreated = true
            return {} as IDBObjectStore
        },
        transaction: (): IDBTransaction => {
            const transaction = {
                oncomplete: null,
                onerror: null,
                onabort: null,
                objectStore: () => objectStore,
            } as unknown as IDBTransaction
            const finish = (): void => {
                queueMicrotask(() => transaction.oncomplete?.call(transaction, new Event('complete')))
            }
            const objectStore = {
                get(key: IDBValidKey): IDBRequest<unknown> {
                    const request = { onsuccess: null, onerror: null } as unknown as IDBRequest<unknown>
                    queueMicrotask(() => {
                        Object.defineProperty(request, 'result', {
                            configurable: true,
                            value: state.get(String(key)),
                        })
                        request.onsuccess?.call(request, new Event('success'))
                        finish()
                    })
                    return request
                },
                put(value: unknown, key: IDBValidKey): IDBRequest<IDBValidKey> {
                    const request = {} as IDBRequest<IDBValidKey>
                    queueMicrotask(() => {
                        state.set(String(key), structuredClone(value))
                        finish()
                    })
                    return request
                },
                delete(key: IDBValidKey): IDBRequest<undefined> {
                    const request = {} as IDBRequest<undefined>
                    queueMicrotask(() => {
                        state.delete(String(key))
                        finish()
                    })
                    return request
                },
            } as IDBObjectStore

            return transaction
        },
        close: (): void => {},
    } as unknown as IDBDatabase

    const factory = {
        open: (): IDBOpenDBRequest => {
            const request = {
                onupgradeneeded: null,
                onsuccess: null,
                onerror: null,
                onblocked: null,
            } as unknown as IDBOpenDBRequest
            Object.defineProperty(request, 'result', { configurable: true, value: database })
            queueMicrotask(() => {
                request.onupgradeneeded?.call(request, new Event('upgradeneeded') as IDBVersionChangeEvent)
                request.onsuccess?.call(request, new Event('success'))
            })
            return request
        },
    } as unknown as IDBFactory

    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory })

    return {
        state,
        restore: () => {
            database.onversionchange?.call(database, new Event('versionchange') as IDBVersionChangeEvent)
            if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor)
            else Reflect.deleteProperty(globalThis, 'indexedDB')
        },
    }
}

Deno.test('Unsplash Access Keys are trimmed and validated without assuming one exact length', () => {
    assertEquals(normalizeUnsplashAccessKey(`  ${VALID_ACCESS_KEY}\n`), VALID_ACCESS_KEY)
    assertEquals(normalizeUnsplashAccessKey('abcdefghijklmnop'), 'abcdefghijklmnop')
    assertEquals(normalizeUnsplashAccessKey('a'.repeat(256)), 'a'.repeat(256))
    assertEquals(normalizeUnsplashAccessKey('too-short'), undefined)
    assertEquals(normalizeUnsplashAccessKey('valid-length-but-has spaces'), undefined)
    assertEquals(normalizeUnsplashAccessKey('a'.repeat(257)), undefined)
    assertEquals(normalizeUnsplashAccessKey(123), undefined)
})

Deno.test('extension storage keeps the Unsplash Access Key local and out of Sync', async () => {
    const mock = installWebextStorage({
        syncStorage: structuredClone(SYNC_DEFAULT),
        backgroundLastTrackedPhoto: 'photo-1',
    })

    try {
        await storage.local.set({ unsplashAccessKey: ` ${VALID_ACCESS_KEY} ` })
        await storage.sync.set(
            { unsplashAccessKey: VALID_ACCESS_KEY } as unknown as Parameters<
                typeof storage.sync.set
            >[0],
        )
        assertEquals(mock.state.unsplashAccessKey, VALID_ACCESS_KEY)
        assertEquals('unsplashAccessKey' in (mock.state.syncStorage as Record<string, unknown>), false)
        assertEquals((await storage.local.get('unsplashAccessKey')).unsplashAccessKey, VALID_ACCESS_KEY)
        assertEquals((await storage.local.get('backgroundLastTrackedPhoto')).backgroundLastTrackedPhoto, 'photo-1')

        await assertRejects(
            () => storage.local.set({ unsplashAccessKey: 'contains unsafe spaces' }),
            TypeError,
            'Invalid Unsplash Access Key',
        )
        assertEquals(mock.state.unsplashAccessKey, VALID_ACCESS_KEY)

        await storage.local.set({ unsplashAccessKey: '   ' })
        assertEquals('unsplashAccessKey' in mock.state, false)

        await storage.local.set({ unsplashAccessKey: VALID_ACCESS_KEY })
        await storage.local.remove('unsplashAccessKey')
        assertEquals('unsplashAccessKey' in mock.state, false)
        assertEquals((await storage.local.get('unsplashAccessKey')).unsplashAccessKey, '')
    } finally {
        mock.restore()
    }
})

Deno.test('online storage keeps the Unsplash Access Key in IndexedDB instead of localStorage', async () => {
    const indexedDb = installIndexedDbMock()
    storage.type.set('localstorage')
    localStorage.removeItem('unsplashAccessKey')

    try {
        await storage.local.set({ unsplashAccessKey: VALID_ACCESS_KEY })
        assertEquals(indexedDb.state.get('unsplashAccessKey'), VALID_ACCESS_KEY)
        assertEquals(localStorage.getItem('unsplashAccessKey'), null)
        assertEquals((await storage.local.get('unsplashAccessKey')).unsplashAccessKey, VALID_ACCESS_KEY)

        await storage.local.remove('unsplashAccessKey')
        assertEquals(indexedDb.state.has('unsplashAccessKey'), false)
    } finally {
        localStorage.removeItem('unsplashAccessKey')
        indexedDb.restore()
    }

    await new Promise((resolve) => setTimeout(resolve, 0))
})

Deno.test('Unsplash key settings use password input and local-only disclosure', () => {
    const html = Deno.readTextFileSync('src/settings.html')
    const settings = Deno.readTextFileSync('src/scripts/settings.ts')

    assertStringIncludes(html, 'id="i_unsplash-access-key"')
    assertStringIncludes(html, 'type="password"')
    assertStringIncludes(html, 'id="unsplash-access-key-required"')
    assertStringIncludes(html, 'id="unsplash-access-key-status"')
    assertStringIncludes(html, 'aria-live="polite"')
    assertStringIncludes(html, 'Never included in exports, remote sync, or recovery snapshots.')
    assertStringIncludes(settings, "new CustomEvent('unsplash-key-change', { detail: { available } })")
    assertEquals('unsplashAccessKey' in SYNC_DEFAULT, false)
    assertEquals(LOCAL_DEFAULT.unsplashAccessKey, '')
    assert(!settings.includes("localStorage.setItem('unsplashAccessKey'"))
    assert(!settings.includes("sessionStorage.setItem('unsplashAccessKey'"))
})

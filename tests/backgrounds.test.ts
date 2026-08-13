import './init.test.ts'

import { assertEquals, assertRejects, assertStrictEquals } from '@std/assert'
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import {
    __testing as backgroundTesting,
    applyBackground,
    filtersUpdate,
    isBackgroundImage,
} from '../src/scripts/features/backgrounds/index.ts'
import { updateCredits } from '../src/scripts/features/backgrounds/credits.ts'
import {
    currentBackgroundRuntimeVersion,
    invalidateBackgroundRuntime,
} from '../src/scripts/features/backgrounds/cache.ts'
import {
    getFileFromCache,
    localBackgroundId,
    removeFilesFromCache,
    sanitizeMetadatas,
    saveFileToCache,
    uniqueLocalBackgroundEntries,
} from '../src/scripts/features/backgrounds/local.ts'
import { compressAsBlob, imageDimensions } from '../src/scripts/shared/compress.ts'
import { storage } from '../src/scripts/storage.ts'
import {
    backgroundSourcePatch,
    mergeBackgroundPatch,
    queryCollectionName,
} from '../src/scripts/features/backgrounds/query.ts'
import { validateBackgroundUrl } from '../src/scripts/features/backgrounds/urls.ts'
import { safeUnsplashAssetUrl } from '../src/scripts/features/contextmenu.ts'

class MemoryCache {
    entries = new Map<string, Response>()
    failPart = ''
    deleted: string[] = []

    put(request: Request, response: Response): Promise<void> {
        if (request.url.endsWith(this.failPart) && this.failPart) {
            return Promise.reject(new Error('cache put failed'))
        }
        this.entries.set(request.url, response.clone())
        return Promise.resolve()
    }

    match(request: Request | string): Promise<Response | undefined> {
        const key = typeof request === 'string' ? request : request.url
        return Promise.resolve(this.entries.get(key)?.clone())
    }

    delete(request: Request | string): Promise<boolean> {
        const key = typeof request === 'string' ? request : request.url
        this.deleted.push(key)
        return Promise.resolve(this.entries.delete(key))
    }

    keys(): Promise<Request[]> {
        return Promise.resolve([...this.entries.keys()].map((key) => new Request(key)))
    }
}

function installCache(cache: MemoryCache): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches')
    Object.defineProperty(globalThis, 'caches', {
        configurable: true,
        value: {
            open: () => Promise.resolve(cache as unknown as Cache),
        },
    })

    return () => {
        if (descriptor) {
            Object.defineProperty(globalThis, 'caches', descriptor)
        } else {
            Reflect.deleteProperty(globalThis, 'caches')
        }
    }
}

Deno.test('background search form selects the search provider', () => {
    const backgrounds = structuredClone(SYNC_DEFAULT.backgrounds)
    backgrounds.type = 'images'
    backgrounds.images = 'unsplash-images-random'

    assertEquals(queryCollectionName('f_background-user-search', backgrounds), 'unsplash-images-search')
    assertEquals(queryCollectionName('i_background-user-search', backgrounds), 'unsplash-images-search')
})

Deno.test('retired and unknown image providers safely fall back to direct Unsplash random', () => {
    assertEquals(backgroundTesting.normalizedImageCollectionName('unsplash-images-random'), 'unsplash-images-random')
    assertEquals(backgroundTesting.normalizedImageCollectionName('bonjourr-images-daylight'), 'unsplash-images-random')
    assertEquals(backgroundTesting.normalizedImageCollectionName('unknown-images-source'), 'unsplash-images-random')
})

Deno.test('URL background validation rejects non-web schemes without a proxy request', async () => {
    assertEquals(await validateBackgroundUrl('file:///private/image.png'), 'NOT_URL')
    assertEquals(await validateBackgroundUrl('javascript:alert(1)'), 'NOT_URL')
})

Deno.test('background collection form selects the collection provider', () => {
    const backgrounds = structuredClone(SYNC_DEFAULT.backgrounds)
    backgrounds.type = 'images'
    backgrounds.images = 'unsplash-images-random'

    assertEquals(queryCollectionName('f_background-user-coll', backgrounds), 'unsplash-images-collections')
    assertEquals(queryCollectionName('i_background-user-coll', backgrounds), 'unsplash-images-collections')
})

Deno.test('unknown background query form falls back to the selected provider', () => {
    const backgrounds = structuredClone(SYNC_DEFAULT.backgrounds)
    backgrounds.type = 'images'
    backgrounds.images = 'unsplash-images-search'

    assertEquals(queryCollectionName('custom-form', backgrounds), 'unsplash-images-search')
})

Deno.test('background texture patch preserves the current query', () => {
    const backgrounds = structuredClone(SYNC_DEFAULT.backgrounds)
    backgrounds.type = 'images'
    backgrounds.images = 'unsplash-images-search'
    backgrounds.query = 'nature'

    const next = mergeBackgroundPatch(backgrounds, { texture: { type: 'none' } })

    assertEquals(next.images, 'unsplash-images-search')
    assertEquals(next.query, 'nature')
    assertEquals(next.texture.type, 'none')
})

Deno.test('background provider patch preserves the current query when asked', () => {
    const backgrounds = structuredClone(SYNC_DEFAULT.backgrounds)
    backgrounds.type = 'images'
    backgrounds.images = 'unsplash-images-random'
    backgrounds.query = 'nature'

    const next = mergeBackgroundPatch(backgrounds, backgroundSourcePatch('images', 'unsplash-images-search'))

    assertEquals(next.images, 'unsplash-images-search')
    assertEquals(next.query, 'nature')
})

Deno.test('remote background validation rejects malformed image descriptors', () => {
    assertEquals(isBackgroundImage({ format: 'image', urls: { full: 'https://example/full' } }), false)
    assertEquals(isBackgroundImage({ format: 'video', urls: { full: 'x', small: 'y' } }), false)
    assertEquals(isBackgroundImage({ format: 'image', urls: { full: 'x', small: 'y' } }), true)
})

Deno.test('background credits never expose unsafe provider links and clear stale attribution', () => {
    document.body.innerHTML = `
        <div id="credit-text"><a href="https://stale.example">stale</a></div>
        <div id="background-attribution"><a href="https://stale.example">stale</a></div>
        <a id="download-background"></a>
        <button id="b_interface-background-download"></button>
    `

    updateCredits({
        format: 'image',
        urls: { full: 'https://example.com/full', small: 'https://example.com/small' },
        page: 'javascript:alert(1)',
        username: 'provider',
    })
    assertEquals(document.querySelector('#credit-text a'), null)
    assertEquals(document.getElementById('background-attribution')?.hidden, true)

    updateCredits({
        format: 'image',
        urls: { full: 'https://example.com/full', small: 'https://example.com/small' },
        page: 'https://photos.example/image',
        username: 'provider',
    })
    assertEquals(document.querySelector<HTMLAnchorElement>('#credit-text a')?.href, 'https://photos.example/image')
})

Deno.test('Unsplash backgrounds expose compliant attribution and only exact download locations', () => {
    document.body.innerHTML = `
        <div id="background-attribution" hidden></div>
        <a id="download-background"></a>
        <button id="b_interface-background-download" disabled></button>
    `

    updateCredits({
        format: 'image',
        urls: {
            full: 'https://images.unsplash.com/photo-123',
            small: 'https://images.unsplash.com/photo-123?w=400',
        },
        page: 'https://unsplash.com/photos/example',
        username: 'photographer',
        name: 'Photo Grapher',
        download: 'https://api.unsplash.com/photos/abc_123/download?ixid=tracking',
    })

    const attribution = document.getElementById('background-attribution')
    const links = attribution?.querySelectorAll<HTMLAnchorElement>('a') ?? []
    assertEquals(attribution?.hidden, false)
    assertEquals(attribution?.textContent, 'Photo by Photo Grapher · Unsplash')
    assertEquals(links.length, 2)
    assertEquals(links[0].href, 'https://unsplash.com/@photographer?utm_source=bonjourr-fork&utm_medium=referral')
    assertEquals(links[1].href, 'https://unsplash.com/?utm_source=bonjourr-fork&utm_medium=referral')
    assertEquals(
        document.querySelector<HTMLAnchorElement>('#download-background')?.dataset.downloadLocation,
        'https://api.unsplash.com/photos/abc_123/download?ixid=tracking',
    )
    assertEquals(document.querySelector<HTMLButtonElement>('#b_interface-background-download')?.disabled, false)

    updateCredits({
        format: 'image',
        urls: {
            full: 'https://images.unsplash.com/photo-123',
            small: 'https://images.unsplash.com/photo-123?w=400',
        },
        page: 'https://example.com/not-unsplash',
        username: 'attacker',
        download: 'https://api.unsplash.com/photos/abc_123/download/extra',
    })

    assertEquals(attribution?.hidden, true)
    assertEquals(document.querySelector<HTMLAnchorElement>('#download-background')?.dataset.downloadLocation, undefined)
    assertEquals(document.querySelector<HTMLButtonElement>('#b_interface-background-download')?.disabled, true)
})

Deno.test('Unsplash downloads only accept known image delivery origins', () => {
    assertEquals(
        safeUnsplashAssetUrl('https://images.unsplash.com/photo-123?fm=jpg')?.href,
        'https://images.unsplash.com/photo-123?fm=jpg',
    )
    assertEquals(
        safeUnsplashAssetUrl('https://plus.unsplash.com/premium_photo-123')?.origin,
        'https://plus.unsplash.com',
    )
    assertEquals(safeUnsplashAssetUrl('https://images.unsplash.com.evil.example/photo-123'), undefined)
    assertEquals(safeUnsplashAssetUrl('https://user@images.unsplash.com/photo-123'), undefined)
    assertEquals(safeUnsplashAssetUrl('http://images.unsplash.com/photo-123'), undefined)
    assertEquals(safeUnsplashAssetUrl('https://images.unsplash.com/photo-123#fragment'), undefined)
})

Deno.test({
    name: 'a stale background task cannot overwrite config after runtime invalidation',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        storage.type.set('localstorage')
        const initial = structuredClone(SYNC_DEFAULT)
        initial.backgrounds.bright = 0.55
        await storage.sync.replace(initial)
        const staleVersion = currentBackgroundRuntimeVersion()

        try {
            const pending = filtersUpdate({ bright: 0.1 }, staleVersion)
            invalidateBackgroundRuntime()
            await pending

            assertEquals((await storage.sync.get()).backgrounds.bright, 0.55)
        } finally {
            await storage.sync.clear()
        }
    },
})

Deno.test('local background deduplication keeps each new file paired with its own id', async () => {
    const duplicate = new File(['old'], 'duplicate.png', { type: 'image/png', lastModified: 1 })
    const fresh = new File(['new'], 'fresh.png', { type: 'image/png', lastModified: 2 })
    const duplicateId = await localBackgroundId(duplicate)
    const existing = {
        [duplicateId]: { lastUsed: new Date(0).toString() },
    }

    const entries = await uniqueLocalBackgroundEntries([duplicate, fresh, fresh], existing)

    assertEquals(entries.length, 1)
    assertStrictEquals(entries[0].file, fresh)
    assertEquals(entries[0].id, (await uniqueLocalBackgroundEntries([fresh], {}))[0].id)

    const sameMetadataA = new File(['aa'], 'same.png', { type: 'image/png', lastModified: 3 })
    const sameMetadataB = new File(['bb'], 'same.png', { type: 'image/png', lastModified: 3 })
    assertEquals((await uniqueLocalBackgroundEntries([sameMetadataA, sameMetadataB], {})).length, 2)
})

Deno.test({
    name: 'local background cache stores and reads a complete full/small pair',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const cache = new MemoryCache()
        const restore = installCache(cache)

        try {
            await saveFileToCache('pair', {
                full: new Blob(['full'], { type: 'image/png' }),
                small: new Blob(['small'], { type: 'image/webp' }),
            })
            const result = await getFileFromCache('pair')

            assertEquals(await result.full.text(), 'full')
            assertEquals(await result.small.text(), 'small')
            assertEquals(cache.entries.size, 2)
        } finally {
            restore()
        }
    },
})

Deno.test({
    name: 'local background cache rolls back both entries when either put fails',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const cache = new MemoryCache()
        cache.failPart = '/small'
        const restore = installCache(cache)

        try {
            await assertRejects(() =>
                saveFileToCache('partial', {
                    full: new Blob(['full'], { type: 'image/png' }),
                    small: new Blob(['small'], { type: 'image/png' }),
                })
            )
            assertEquals(cache.entries.size, 0)
            assertEquals(cache.deleted.toSorted(), [
                'http://127.0.0.1:8888/partial/full',
                'http://127.0.0.1:8888/partial/small',
            ])
        } finally {
            restore()
        }
    },
})

Deno.test({
    name: 'local background cache waits for both entries to be deleted',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const cache = new MemoryCache()
        const restore = installCache(cache)

        try {
            await saveFileToCache('remove-me', {
                full: new Blob(['full'], { type: 'image/png' }),
                small: new Blob(['small'], { type: 'image/png' }),
            })
            await removeFilesFromCache(['remove-me'])

            assertEquals(cache.entries.size, 0)
            assertEquals(cache.deleted.toSorted(), [
                'http://127.0.0.1:8888/remove-me/full',
                'http://127.0.0.1:8888/remove-me/small',
            ])
        } finally {
            restore()
        }
    },
})

Deno.test({
    name: 'metadata sanitizer repairs incomplete cache pairs without deleting the remaining user image',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const cache = new MemoryCache()
        const restore = installCache(cache)
        storage.type.set('localstorage')
        await cache.put(
            new Request('http://127.0.0.1:8888/orphan/full'),
            new Response(new Blob(['full'], { type: 'image/png' })),
        )

        try {
            const local = await sanitizeMetadatas({
                backgroundCollections: {},
                backgroundUrls: {},
                backgroundFiles: { orphan: { lastUsed: new Date().toString() } },
            })

            assertEquals(Object.keys(local.backgroundFiles), ['orphan'])
            assertEquals(cache.entries.size, 2)
            assertEquals(await (await cache.match('http://127.0.0.1:8888/orphan/full'))?.text(), 'full')
            assertEquals(await (await cache.match('http://127.0.0.1:8888/orphan/small'))?.text(), 'full')
        } finally {
            restore()
        }
    },
})

Deno.test({
    name: 'background DOM releases unselected and removed blob URLs',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const imageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Image')
        const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
        const previousHtml = document.body.innerHTML
        const revoked: string[] = []

        class LoadedImage extends EventTarget {
            width = 100
            height = 100
            naturalWidth = 100
            complete = false
            private value = ''

            set src(value: string) {
                this.value = value
                queueMicrotask(() => {
                    this.complete = true
                    this.dispatchEvent(new Event('load'))
                })
            }

            get src(): string {
                return this.value
            }

            remove(): void {}
        }

        Object.defineProperty(globalThis, 'Image', {
            configurable: true,
            value: LoadedImage as unknown as typeof Image,
        })
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: (url: string): void => {
                revoked.push(url)
            },
        })
        document.body.innerHTML = `
            <div id="background-wrapper" class="hidden"><div id="background-media"></div></div>
            <meta name="theme-color">
        `

        try {
            applyBackground({
                format: 'image',
                color: '#222222',
                urls: { full: 'blob:full', small: 'blob:small' },
            }, 'full')
            await new Promise((resolve) => setTimeout(resolve, 0))

            assertEquals(revoked, ['blob:small'])
            applyBackground('#ffffff')
            assertEquals(revoked, ['blob:small', 'blob:full'])
        } finally {
            document.body.innerHTML = previousHtml
            if (imageDescriptor) Object.defineProperty(globalThis, 'Image', imageDescriptor)
            if (revokeDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
        }
    },
})

Deno.test({
    name: 'imageDimensions rejects image decoding errors',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const imageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Image')

        class BrokenImage extends EventTarget {
            onload: (() => void) | null = null
            onerror: (() => void) | null = null

            set src(_value: string) {
                queueMicrotask(() => this.onerror?.())
            }

            remove(): void {}
        }

        Object.defineProperty(globalThis, 'Image', {
            configurable: true,
            value: BrokenImage as unknown as typeof Image,
        })

        try {
            await assertRejects(() => imageDimensions('blob:broken'), Error, 'Cannot read image dimensions')
        } finally {
            if (imageDescriptor) Object.defineProperty(globalThis, 'Image', imageDescriptor)
        }
    },
})

Deno.test({
    name: 'a failed background image keeps the previous background visible',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const imageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Image')
        const previousHtml = document.body.innerHTML

        class BrokenBackgroundImage extends EventTarget {
            complete = false
            naturalWidth = 0

            set src(_value: string) {
                queueMicrotask(() => this.dispatchEvent(new Event('error')))
            }

            remove(): void {}
        }

        Object.defineProperty(globalThis, 'Image', {
            configurable: true,
            value: BrokenBackgroundImage as unknown as typeof Image,
        })
        document.body.innerHTML = `
            <div id="background-wrapper"><div id="background-media"><div id="previous"></div></div></div>
        `

        try {
            applyBackground({
                format: 'image',
                urls: { full: 'https://example.com/broken.jpg', small: 'https://example.com/broken.jpg' },
            })
            await new Promise((resolve) => setTimeout(resolve, 0))

            assertEquals(document.querySelectorAll('#background-media > div').length, 1)
            assertEquals(document.getElementById('previous')?.isConnected, true)
        } finally {
            document.body.innerHTML = previousHtml
            if (imageDescriptor) Object.defineProperty(globalThis, 'Image', imageDescriptor)
        }
    },
})

Deno.test({
    name: 'compression revokes owned object URLs after errors',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const imageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Image')
        const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
        const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
        const revoked: string[] = []

        class BrokenImage extends EventTarget {
            onload: (() => void) | null = null
            onerror: (() => void) | null = null

            set src(_value: string) {
                queueMicrotask(() => this.onerror?.())
            }

            remove(): void {}
        }

        Object.defineProperty(globalThis, 'Image', {
            configurable: true,
            value: BrokenImage as unknown as typeof Image,
        })
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: (): string => 'blob:compression',
        })
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: (url: string): void => {
                revoked.push(url)
            },
        })

        try {
            await assertRejects(() => compressAsBlob(new Blob(['broken']), { size: 100 }))
            assertEquals(revoked, ['blob:compression'])
        } finally {
            if (imageDescriptor) Object.defineProperty(globalThis, 'Image', imageDescriptor)
            if (createDescriptor) Object.defineProperty(URL, 'createObjectURL', createDescriptor)
            if (revokeDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
        }
    },
})

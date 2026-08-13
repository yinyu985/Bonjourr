import { assert, assertEquals, assertInstanceOf, assertThrows } from '@std/assert'
import {
    buildUnsplashImageUrl,
    fetchUnsplashPhotos,
    trackDownload,
    trackUnsplashDownload,
    UnsplashError,
} from '../src/scripts/features/backgrounds/unsplash.ts'

import type { FetchUnsplashPhotosOptions, UnsplashSource } from '../src/scripts/features/backgrounds/unsplash.ts'

const ACCESS_KEY = 'test_unsplash_access-key'

interface CapturedRequest {
    input: string
    init?: RequestInit
}

Deno.test('Unsplash random requests use BYOK headers and privacy-safe fetch options', async () => {
    const requests: CapturedRequest[] = []
    const images = await fetchUnsplashPhotos({
        ...baseOptions(),
        source: { type: 'random' },
        count: 99,
        fetch: jsonFetcher([validPhoto()], requests),
    })

    assertEquals(images.length, 1)
    assertEquals(requests.length, 1)

    const request = requests[0]
    const url = new URL(request.input)
    const headers = new Headers(request.init?.headers)

    assertEquals(url.origin, 'https://api.unsplash.com')
    assertEquals(url.pathname, '/photos/random')
    assertEquals(url.searchParams.get('orientation'), 'landscape')
    assertEquals(url.searchParams.get('content_filter'), 'high')
    assertEquals(url.searchParams.get('count'), '30')
    assertEquals(url.searchParams.has('query'), false)
    assertEquals(url.searchParams.has('collections'), false)
    assertEquals(url.searchParams.has('client_id'), false)
    assertEquals(headers.get('Authorization'), `Client-ID ${ACCESS_KEY}`)
    assertEquals(headers.get('Accept-Version'), 'v1')
    assertEquals(request.init?.method, 'GET')
    assertEquals(request.init?.credentials, 'omit')
    assertEquals(request.init?.cache, 'no-store')
    assertEquals(request.init?.redirect, 'error')
    assertEquals(request.init?.referrerPolicy, 'no-referrer')
    assertInstanceOf(request.init?.signal, AbortSignal)
})

Deno.test('Unsplash search and collection filters stay mutually exclusive', async () => {
    const searchRequests: CapturedRequest[] = []
    await fetchUnsplashPhotos({
        ...baseOptions(),
        source: { type: 'search', query: '  blue sky & fog  ' },
        fetch: jsonFetcher([validPhoto()], searchRequests),
    })

    const searchUrl = new URL(searchRequests[0].input)
    assertEquals(searchUrl.searchParams.get('query'), 'blue sky & fog')
    assertEquals(searchUrl.searchParams.has('collections'), false)

    const collectionRequests: CapturedRequest[] = []
    await fetchUnsplashPhotos({
        ...baseOptions(),
        source: { type: 'collection', id: ' first-id, second_2 ,third ' },
        fetch: jsonFetcher([validPhoto()], collectionRequests),
    })

    const collectionUrl = new URL(collectionRequests[0].input)
    assertEquals(collectionUrl.pathname, '/photos/random')
    assertEquals(collectionUrl.searchParams.get('collections'), 'first-id,second_2,third')
    assertEquals(collectionUrl.searchParams.has('query'), false)

    let called = false
    const fetcher = ((_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        called = true
        return Promise.resolve(jsonResponse([validPhoto()]))
    }) as typeof fetch
    const mixedSource = { type: 'search', query: 'forest', id: 'collection' } as unknown as UnsplashSource

    const error = await rejectedUnsplashError(() =>
        fetchUnsplashPhotos({ ...baseOptions(), source: mixedSource, fetch: fetcher })
    )
    assertEquals(error.code, 'response')
    assertEquals(called, false)

    const unsafeCollection = { type: 'collection', id: '../photos/random' } as UnsplashSource
    assertEquals(
        (await rejectedUnsplashError(() =>
            fetchUnsplashPhotos({ ...baseOptions(), source: unsafeCollection, fetch: fetcher })
        )).code,
        'response',
    )
    assertEquals(called, false)
})

Deno.test('Unsplash photo responses map to BackgroundImage and preserve Imgix query parameters', async () => {
    const [image] = await fetchUnsplashPhotos({
        ...baseOptions(),
        width: 1920,
        height: 1080,
        source: { type: 'random' },
        fetch: jsonFetcher([validPhoto()]),
    })

    assertEquals(image.id, 'photo_1-test')
    assertEquals(image.format, 'image')
    assertEquals(image.mimetype, 'image/jpeg')
    assertEquals(image.page, 'https://unsplash.com/photos/photo_1-test')
    assertEquals(image.download, 'https://api.unsplash.com/photos/photo_1-test/download?ixid=tracking')
    assertEquals(image.username, 'photographer')
    assertEquals(image.name, 'Photo Grapher')
    assertEquals(image.city, 'Shanghai')
    assertEquals(image.country, 'China')
    assertEquals(image.color, '#1a2B3c')

    const full = new URL(image.urls.full)
    assertEquals(full.origin, 'https://images.unsplash.com')
    assertEquals(full.searchParams.get('ixid'), 'existing-token')
    assertEquals(full.searchParams.get('custom'), 'keep-me')
    assertEquals(full.searchParams.get('w'), '1920')
    assertEquals(full.searchParams.get('h'), '1080')
    assertEquals(full.searchParams.get('fit'), 'crop')
    assertEquals(full.searchParams.get('crop'), 'entropy')
    assertEquals(full.searchParams.get('auto'), 'format')

    const small = new URL(image.urls.small)
    assertEquals(small.searchParams.get('ixid'), 'existing-token')
    assertEquals(small.searchParams.get('custom'), 'keep-me')
    assertEquals(small.searchParams.get('w'), '400')
    assertEquals(small.searchParams.get('h'), '225')
})

Deno.test('Unsplash rejects unsafe image, page, and download URLs at runtime', async () => {
    assertThrows(
        () => buildUnsplashImageUrl('https://images.unsplash.com.evil.test/photo', 100, 100),
        UnsplashError,
    )
    assertThrows(() => buildUnsplashImageUrl('http://images.unsplash.com/photo', 100, 100), UnsplashError)

    const unsafeRaw = validPhoto()
    unsafeRaw.urls = { raw: 'https://evil.test/image?ixid=secret' }
    assertEquals(
        (await rejectedUnsplashError(() =>
            fetchUnsplashPhotos({
                ...baseOptions(),
                source: { type: 'random' },
                fetch: jsonFetcher([unsafeRaw]),
            })
        )).code,
        'response',
    )

    const mismatchedDownload = validPhoto()
    mismatchedDownload.links = {
        html: 'https://unsplash.com/photos/photo_1-test',
        download_location: 'https://api.unsplash.com/photos/another-photo/download',
    }
    assertEquals(
        (await rejectedUnsplashError(() =>
            fetchUnsplashPhotos({
                ...baseOptions(),
                source: { type: 'random' },
                fetch: jsonFetcher([mismatchedDownload]),
            })
        )).code,
        'response',
    )
})

Deno.test('Unsplash validates response shapes instead of trusting API JSON', async () => {
    const objectInsteadOfArray = await rejectedUnsplashError(() =>
        fetchUnsplashPhotos({
            ...baseOptions(),
            source: { type: 'random' },
            fetch: jsonFetcher(validPhoto()),
        })
    )
    assertEquals(objectInsteadOfArray.code, 'response')

    const malformed = validPhoto()
    malformed.user = { username: 'photographer', name: 42 }
    const malformedError = await rejectedUnsplashError(() =>
        fetchUnsplashPhotos({
            ...baseOptions(),
            source: { type: 'random' },
            fetch: jsonFetcher([malformed]),
        })
    )
    assertEquals(malformedError.code, 'response')
})

Deno.test('Unsplash classifies missing, invalid, rate-limit, network, and response errors without leaking keys', async () => {
    const missing = await rejectedUnsplashError(() =>
        fetchUnsplashPhotos({
            ...baseOptions(),
            accessKey: '   ',
            source: { type: 'random' },
            fetch: jsonFetcher([validPhoto()]),
        })
    )
    assertEquals(missing.code, 'missing')

    const invalidLocal = await rejectedUnsplashError(() =>
        fetchUnsplashPhotos({
            ...baseOptions(),
            accessKey: 'invalid key with spaces',
            source: { type: 'random' },
            fetch: jsonFetcher([validPhoto()]),
        })
    )
    assertEquals(invalidLocal.code, 'invalid')

    for (
        const [status, code] of [[401, 'invalid'], [403, 'rate-limit'], [429, 'rate-limit'], [
            500,
            'response',
        ]] as const
    ) {
        const error = await rejectedUnsplashError(() =>
            fetchUnsplashPhotos({
                ...baseOptions(),
                source: { type: 'random' },
                fetch: jsonFetcher({ errors: ['failure'] }, undefined, status),
            })
        )
        assertEquals(error.code, code)
        assertEquals(error.status, status)
        assertEquals(error.message.includes(ACCESS_KEY), false)
    }

    const network = await rejectedUnsplashError(() =>
        fetchUnsplashPhotos({
            ...baseOptions(),
            source: { type: 'random' },
            fetch: (() => Promise.reject(new Error(`failed with ${ACCESS_KEY}`))) as typeof fetch,
        })
    )
    assertEquals(network.code, 'network')
    assertEquals(network.message.includes(ACCESS_KEY), false)
})

Deno.test('Unsplash requests abort on timeout and classify it as a network error', async () => {
    let aborted = false
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                aborted = true
                reject(new DOMException('Aborted', 'AbortError'))
            }, { once: true })
        })
    }) as typeof fetch

    const error = await rejectedUnsplashError(() =>
        fetchUnsplashPhotos({
            ...baseOptions(),
            source: { type: 'random' },
            timeoutMs: 5,
            fetch: hangingFetch,
        })
    )

    assertEquals(error.code, 'network')
    assert(aborted)
})

Deno.test('Unsplash download tracking only calls the official download_location and returns a safe asset URL', async () => {
    const requests: CapturedRequest[] = []
    const downloadLocation = 'https://api.unsplash.com/photos/photo_1-test/download?ixid=tracking-token'
    const imageUrl = await trackUnsplashDownload(downloadLocation, ACCESS_KEY, {
        fetch: jsonFetcher({ url: 'https://plus.unsplash.com/premium_photo?ixid=asset-token' }, requests),
    })

    assertEquals(imageUrl, 'https://plus.unsplash.com/premium_photo?ixid=asset-token')
    assertEquals(requests[0].input, downloadLocation)
    assertEquals(new Headers(requests[0].init?.headers).get('Authorization'), `Client-ID ${ACCESS_KEY}`)
    assertEquals(requests[0].init?.credentials, 'omit')
    assertEquals(requests[0].init?.cache, 'no-store')
    assertEquals(requests[0].init?.redirect, 'error')

    const aliasResult = await trackDownload(downloadLocation, ACCESS_KEY, {
        fetch: jsonFetcher({ url: 'https://images.unsplash.com/photo-safe' }),
    })
    assertEquals(aliasResult, 'https://images.unsplash.com/photo-safe')
})

Deno.test('Unsplash download tracking rejects endpoint and returned-URL confusion attacks before use', async () => {
    const invalidLocations = [
        'http://api.unsplash.com/photos/photo/download',
        'https://api.unsplash.com.evil.test/photos/photo/download',
        'https://user@api.unsplash.com/photos/photo/download',
        'https://api.unsplash.com/photos/photo/download/extra',
        'https://api.unsplash.com/photos/photo/download#fragment',
    ]

    for (const location of invalidLocations) {
        let called = false
        const error = await rejectedUnsplashError(() =>
            trackUnsplashDownload(location, ACCESS_KEY, {
                fetch: ((_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
                    called = true
                    return Promise.resolve(jsonResponse({ url: 'https://images.unsplash.com/photo-safe' }))
                }) as typeof fetch,
            })
        )
        assertEquals(error.code, 'response')
        assertEquals(called, false)
    }

    for (const assetUrl of ['http://images.unsplash.com/photo', 'https://evil.test/photo']) {
        const error = await rejectedUnsplashError(() =>
            trackUnsplashDownload('https://api.unsplash.com/photos/photo/download', ACCESS_KEY, {
                fetch: jsonFetcher({ url: assetUrl }),
            })
        )
        assertEquals(error.code, 'response')
    }
})

function baseOptions(): Omit<FetchUnsplashPhotosOptions, 'source'> {
    return {
        accessKey: ACCESS_KEY,
        width: 1600,
        height: 900,
    }
}

function validPhoto(): Record<string, unknown> {
    return {
        id: 'photo_1-test',
        color: '#1a2B3c',
        urls: {
            raw: 'https://images.unsplash.com/photo-safe?ixid=existing-token&custom=keep-me',
        },
        links: {
            html: 'https://unsplash.com/photos/photo_1-test',
            download_location: 'https://api.unsplash.com/photos/photo_1-test/download?ixid=tracking',
        },
        user: {
            username: 'photographer',
            name: 'Photo Grapher',
        },
        location: {
            city: 'Shanghai',
            country: 'China',
        },
    }
}

function jsonFetcher(body: unknown, requests?: CapturedRequest[], status = 200): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requests?.push({ input: String(input), init })
        return Promise.resolve(jsonResponse(body, status))
    }) as typeof fetch
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

async function rejectedUnsplashError(operation: () => Promise<unknown>): Promise<UnsplashError> {
    try {
        await operation()
    } catch (error) {
        assertInstanceOf(error, UnsplashError)
        return error
    }

    throw new Error('Expected an UnsplashError')
}

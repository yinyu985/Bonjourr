import type { BackgroundImage } from '../../../types/shared.ts'

const UNSPLASH_API_ORIGIN = 'https://api.unsplash.com'
const UNSPLASH_API_VERSION = 'v1'
const MIN_ACCESS_KEY_LENGTH = 16
const MAX_ACCESS_KEY_LENGTH = 256
const DEFAULT_COUNT = 30
const MAX_COUNT = 30
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_IMAGE_DIMENSION = 8192
const SMALL_IMAGE_MAX_DIMENSION = 400
const MAX_COLLECTION_IDS = 30
const MAX_COLLECTIONS_LENGTH = 200
const UNSPLASH_PAGE_ORIGIN = 'https://unsplash.com'
const UNSPLASH_ASSET_ORIGINS = new Set([
    'https://images.unsplash.com',
    'https://image.unsplash.com',
    'https://plus.unsplash.com',
])

export type UnsplashSource =
    | { type: 'random' }
    | { type: 'search'; query: string }
    | { type: 'collection'; id: string }

export type UnsplashErrorCode = 'missing' | 'invalid' | 'rate-limit' | 'network' | 'response'

export interface UnsplashBackgroundImage extends BackgroundImage {
    id: string
    download: string
}

export interface FetchUnsplashPhotosOptions extends UnsplashRequestOptions {
    accessKey: string
    source: UnsplashSource
    width: number
    height: number
    count?: number
}

export interface UnsplashRequestOptions {
    timeoutMs?: number
    fetch?: typeof globalThis.fetch
}

export class UnsplashError extends Error {
    readonly code: UnsplashErrorCode
    readonly status?: number

    constructor(code: UnsplashErrorCode, message: string, status?: number) {
        super(message)
        this.name = 'UnsplashError'
        this.code = code
        this.status = status
    }
}

export { UnsplashError as UnsplashApiError }

export async function fetchUnsplashPhotos(
    options: FetchUnsplashPhotosOptions,
): Promise<UnsplashBackgroundImage[]> {
    const accessKey = validAccessKey(options.accessKey)
    const count = normalizeCount(options.count)
    const width = normalizeDimension(options.width)
    const height = normalizeDimension(options.height)
    const url = buildRandomPhotosUrl(options.source, count)
    const response = await unsplashRequest(url, accessKey, options)

    assertSuccessfulResponse(response)

    const payload = await responseJson(response)
    if (!Array.isArray(payload) || payload.length === 0 || payload.length > count) {
        throw responseError()
    }

    return payload.map((photo) => mapPhoto(photo, width, height))
}

export function buildUnsplashImageUrl(rawUrl: string, width: number, height: number): string {
    const url = safeUrl(rawUrl, UNSPLASH_ASSET_ORIGINS)
    if (!url) throw responseError()

    url.searchParams.set('w', String(normalizeDimension(width)))
    url.searchParams.set('h', String(normalizeDimension(height)))
    url.searchParams.set('fit', 'crop')
    url.searchParams.set('crop', 'entropy')
    url.searchParams.set('auto', 'format')
    return url.href
}

export async function trackUnsplashDownload(
    downloadLocation: string,
    accessKey: string,
    options: UnsplashRequestOptions = {},
): Promise<string> {
    const key = validAccessKey(accessKey)
    const url = safeDownloadLocation(downloadLocation)
    if (!url) throw responseError()

    const response = await unsplashRequest(url, key, options)
    assertSuccessfulResponse(response)

    const payload = await responseJson(response)
    if (!isRecord(payload) || typeof payload.url !== 'string') throw responseError()

    const assetUrl = safeUrl(payload.url, UNSPLASH_ASSET_ORIGINS)
    if (!assetUrl) throw responseError()
    return assetUrl.href
}

export async function trackDownload(
    downloadLocation: string,
    accessKey: string,
    options: UnsplashRequestOptions = {},
): Promise<string> {
    return await trackUnsplashDownload(downloadLocation, accessKey, options)
}

function buildRandomPhotosUrl(source: UnsplashSource, count: number): URL {
    const url = new URL('/photos/random', UNSPLASH_API_ORIGIN)
    url.searchParams.set('orientation', 'landscape')
    url.searchParams.set('content_filter', 'high')
    url.searchParams.set('count', String(count))

    if (!isRecord(source)) throw responseError()

    switch (source.type) {
        case 'random': {
            if (!hasOnlyKeys(source, ['type'])) throw responseError()
            break
        }
        case 'search': {
            if (!hasOnlyKeys(source, ['type', 'query'])) throw responseError()
            const query = normalizedSearchQuery(source.query)
            url.searchParams.set('query', query)
            break
        }
        case 'collection': {
            if (!hasOnlyKeys(source, ['type', 'id'])) throw responseError()
            url.searchParams.set('collections', normalizedCollectionIds(source.id))
            break
        }
        default:
            throw responseError()
    }

    return url
}

async function unsplashRequest(
    url: URL,
    accessKey: string,
    options: UnsplashRequestOptions,
): Promise<Response> {
    const timeoutMs = normalizeTimeout(options.timeoutMs)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const fetcher = options.fetch ?? globalThis.fetch

    try {
        return await fetcher(url.href, {
            method: 'GET',
            headers: {
                Authorization: `Client-ID ${accessKey}`,
                'Accept-Version': UNSPLASH_API_VERSION,
                Accept: 'application/json',
            },
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
        })
    } catch (_) {
        throw new UnsplashError('network', 'Cannot connect to Unsplash')
    } finally {
        clearTimeout(timeout)
    }
}

function assertSuccessfulResponse(response: Response): void {
    if (response.ok) return

    if (response.status === 401) {
        throw new UnsplashError('invalid', 'Unsplash rejected the Access Key', response.status)
    }

    if (response.status === 403 || response.status === 429) {
        throw new UnsplashError('rate-limit', 'Unsplash rate limit reached', response.status)
    }

    throw new UnsplashError('response', 'Unsplash returned an unexpected response', response.status)
}

async function responseJson(response: Response): Promise<unknown> {
    try {
        return await response.json()
    } catch (_) {
        throw responseError()
    }
}

function mapPhoto(value: unknown, width: number, height: number): UnsplashBackgroundImage {
    if (!isRecord(value)) throw responseError()

    const id = photoId(value.id)
    const color = photoColor(value.color)
    const urls = requiredRecord(value.urls)
    const links = requiredRecord(value.links)
    const user = requiredRecord(value.user)
    const rawUrl = requiredString(urls.raw)
    const page = safePhotoPage(requiredString(links.html))
    const download = safeDownloadLocation(requiredString(links.download_location), id)
    const username = requiredString(user.username)
    const name = requiredString(user.name)

    if (!page || !download) throw responseError()

    const location = optionalLocation(value.location)
    const smallScale = Math.min(1, SMALL_IMAGE_MAX_DIMENSION / Math.max(width, height))
    const smallWidth = Math.max(1, Math.round(width * smallScale))
    const smallHeight = Math.max(1, Math.round(height * smallScale))
    const image: UnsplashBackgroundImage = {
        id,
        format: 'image',
        mimetype: 'image/jpeg',
        urls: {
            full: buildUnsplashImageUrl(rawUrl, width, height),
            small: buildUnsplashImageUrl(rawUrl, smallWidth, smallHeight),
        },
        page: page.href,
        username,
        name,
        download: download.href,
    }

    if (color) image.color = color
    if (location?.city) image.city = location.city
    if (location?.country) image.country = location.country
    return image
}

function validAccessKey(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new UnsplashError('missing', 'An Unsplash Access Key is required')
    }

    const key = value.trim()
    if (
        key.length < MIN_ACCESS_KEY_LENGTH ||
        key.length > MAX_ACCESS_KEY_LENGTH ||
        !/^[A-Za-z0-9_-]+$/.test(key)
    ) {
        throw new UnsplashError('invalid', 'The Unsplash Access Key is invalid')
    }

    return key
}

function normalizeCount(value?: number): number {
    if (value === undefined) return DEFAULT_COUNT
    if (!Number.isSafeInteger(value) || value < 1) throw responseError()
    return Math.min(value, MAX_COUNT)
}

function normalizeDimension(value: number): number {
    if (!Number.isFinite(value) || value <= 0) throw responseError()
    return Math.min(MAX_IMAGE_DIMENSION, Math.max(1, Math.round(value)))
}

function normalizeTimeout(value?: number): number {
    if (value === undefined) return DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(value) || value < 1) throw responseError()
    return value
}

function normalizedSearchQuery(value: unknown): string {
    if (typeof value !== 'string') throw responseError()

    const normalized = value.trim()
    if (normalized === '' || normalized.length > 200) throw responseError()
    return normalized
}

function normalizedCollectionIds(value: unknown): string {
    if (typeof value !== 'string' || value.length > MAX_COLLECTIONS_LENGTH) throw responseError()

    const ids = value.split(',').map((id) => id.trim())
    if (
        ids.length < 1 ||
        ids.length > MAX_COLLECTION_IDS ||
        ids.some((id) => id === '' || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id))
    ) {
        throw responseError()
    }

    return ids.join(',')
}

function photoId(value: unknown): string {
    const id = requiredString(value)
    if (id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) throw responseError()
    return id
}

function photoColor(value: unknown): string | undefined {
    if (value === null) return
    if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(value)) throw responseError()
    return value
}

function optionalLocation(value: unknown): { city?: string; country?: string } | undefined {
    if (value === undefined || value === null) return
    if (!isRecord(value)) throw responseError()

    return {
        city: optionalNullableString(value.city),
        country: optionalNullableString(value.country),
    }
}

function optionalNullableString(value: unknown): string | undefined {
    if (value === undefined || value === null) return
    if (typeof value !== 'string') throw responseError()

    const normalized = value.trim()
    return normalized || undefined
}

function safePhotoPage(value: string): URL | undefined {
    const url = safeUrl(value, new Set([UNSPLASH_PAGE_ORIGIN]))
    if (!url || !/^\/photos\/[^/]+\/?$/.test(url.pathname)) return
    return url
}

function safeDownloadLocation(value: string, expectedId?: string): URL | undefined {
    const url = safeUrl(value, new Set([UNSPLASH_API_ORIGIN]))
    if (!url) return

    const match = /^\/photos\/([A-Za-z0-9_-]+)\/download$/.exec(url.pathname)
    if (!match || (expectedId !== undefined && match[1] !== expectedId)) return
    return url
}

function safeUrl(value: string, allowedOrigins: ReadonlySet<string>): URL | undefined {
    try {
        const url = new URL(value)
        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.hash ||
            !allowedOrigins.has(url.origin)
        ) {
            return
        }
        return url
    } catch (_) {
        return
    }
}

function requiredRecord(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) throw responseError()
    return value
}

function requiredString(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') throw responseError()
    return value
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
    return Object.keys(value).every((key) => allowed.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function responseError(): UnsplashError {
    return new UnsplashError('response', 'Unsplash returned an unexpected response')
}

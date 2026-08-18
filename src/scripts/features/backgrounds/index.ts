import { handleBackgroundActions, initBackgroundActionsEvents } from '../contextmenu.ts'
import { settingsBackgroundColor } from '../others.ts'
import { safeUnsplashDownloadLocation, toggleCredits, updateCredits } from './credits.ts'
import { backgroundQueryValue, backgroundSourcePatch, mergeBackgroundPatch, queryCollectionName } from './query.ts'
import {
    currentBackgroundRuntimeVersion,
    invalidateBackgroundRuntime,
    isCurrentBackgroundRuntimeVersion,
} from './cache.ts'
import { TEXTURE_RANGES } from './textures.ts'
import { fetchUnsplashPhotos, trackUnsplashDownload, UnsplashError } from './unsplash.ts'

import { colorInput, turnRefreshButton, webkitRangeTrackColor } from '../../shared/dom.ts'
import { needsChange, userDate } from '../../shared/time.ts'
import { networkForm } from '../../shared/form.ts'
import { rgbToHex } from '../../shared/generic.ts'
import { debounce } from '../../utils/debounce.ts'
import { tradThis } from '../../utils/translations.ts'
import { storage } from '../../storage.ts'

import type { Background, BackgroundImage, Frequency } from '../../../types/shared.ts'
import type { Backgrounds, Sync } from '../../../types/sync.ts'
import type { Local } from '../../../types/local.ts'
import type { BackgroundPatch } from './query.ts'

type BackgroundSize = 'full' | 'small'

interface CollectionGetReturn {
    images: () => BackgroundImage[]
}

interface CollectionSetReturn {
    fromList: (list: Background[]) => Local
    fromApi: (json: Record<string, Background[]>) => Local
}

interface BackgroundQueryUpdate {
    targetId: string
    value: string
}

export interface BackgroundUpdate {
    freq?: string
    type?: string
    blur?: string
    blurenter?: true
    color?: string
    query?: BackgroundQueryUpdate
    querydraft?: BackgroundQueryUpdate
    bright?: string
    refresh?: Event
    texture?: string
    provider?: string
    texturecolor?: string
    texturesize?: string
    textureopacity?: string
}

interface PendingBackgroundProperties {
    blur?: number
    bright?: number
    texture?: Backgrounds['texture']
}

const propertiesUpdateDebounce = debounce(filtersUpdate, 600, { barrier: true })
const colorUpdateDebounce = debounce(solidUpdate, 600, { barrier: true })
const formBackgroundUserColl = networkForm('f_background-user-coll')
const formBackgroundUserSearch = networkForm('f_background-user-search')
const BACKGROUND_FETCH_TIMEOUT_MS = 10_000
const MAX_BACKGROUND_REQUEST_PIXELS = 8_294_400
const BACKGROUND_IMAGE_LOAD_TIMEOUT_MS = 20_000
const DEFAULT_IMAGE_COLLECTION = 'unsplash-images-random'
const UNSPLASH_BATCH_SIZE = 20
const UNSPLASH_COLLECTIONS = new Set([
    DEFAULT_IMAGE_COLLECTION,
    'unsplash-images-collections',
    'unsplash-images-search',
])
let pendingBackgroundProperties: PendingBackgroundProperties = {}
const pendingBackgroundWrites = new Set<Promise<void>>()
const pendingBackgroundWriteErrors: unknown[] = []
let backgroundPatchQueue: Promise<void> = Promise.resolve()
let keyChangeListenerInitialized = false

export function backgroundsInit(sync: Sync, local: Local, init?: true): void {
    if (init) {
        // Rush background opacity to reduce black frames
        const type = sync.backgrounds.type
        const isColor = type === 'color'
        const wrapper = document.getElementById('background-wrapper')

        if (isColor) {
            wrapper?.classList.remove('hidden')
        }

        // <!> To clean up
        const pauseButton = document.getElementById('b_interface-background-pause')
        const isPaused = sync.backgrounds.frequency === 'pause'
        pauseButton?.classList.toggle('paused', isPaused)

        initBackgroundActionsEvents()

        if (!keyChangeListenerInitialized) {
            document.addEventListener('unsplash-key-change', () => {
                void handleUnsplashKeyChange().catch((err) => {
                    console.warn('[Backgrounds] Cannot apply Unsplash Access Key change', err)
                })
            })
            keyChangeListenerInitialized = true
        }
    }

    toggleCredits(sync.backgrounds)
    applyFilters(sync.backgrounds)
    applyTexture(sync.backgrounds.texture)
    handleBackgroundActions(sync.backgrounds)
    document.getElementById('background-wrapper')?.setAttribute('data-type', sync.backgrounds.type)

    switch (sync.backgrounds.type) {
        case 'color': {
            applyBackground(sync.backgrounds.color)
            break
        }
        default: {
            void backgroundCacheControl(sync.backgrounds, local).catch((err) => {
                console.warn('[Backgrounds] Cannot load background collection', err)
            })
        }
    }
}

async function handleUnsplashKeyChange(): Promise<void> {
    invalidateBackgroundRuntime()

    const [sync, local] = await Promise.all([storage.sync.get(), storage.local.get()])
    const collections = Object.fromEntries(
        Object.entries(local.backgroundCollections).filter(([key]) => !key.startsWith('unsplash-images-')),
    )

    local.backgroundCollections = collections
    local.backgroundLastChange = ''
    local.backgroundLastTrackedPhoto = ''
    await storage.local.set({
        backgroundCollections: collections,
        backgroundLastChange: '',
        backgroundLastTrackedPhoto: '',
    })

    if (sync.backgrounds.type !== 'images') return

    removeBackgrounds()
    updateCredits()

    if (!local.unsplashAccessKey) {
        showImageFallback(sync.backgrounds.color)
        showUnsplashStatus('missing')
        return
    }

    await backgroundCacheControl(sync.backgrounds, local, true)
}

// 	Storage update

export function backgroundUpdate(update: BackgroundUpdate): Promise<void> {
    const pendingWrite = tracksImmediateBackgroundWrite(update) ? trackPendingBackgroundWrite() : undefined

    return runBackgroundUpdate(update, pendingWrite?.done).catch((err) => {
        pendingWrite?.fail(err)
        throw err
    }).finally(() => pendingWrite?.done())
}

export async function waitForPendingBackgroundWrites(): Promise<void> {
    while (pendingBackgroundWrites.size > 0) {
        await Promise.allSettled([...pendingBackgroundWrites])
    }

    if (pendingBackgroundWriteErrors.length > 0) {
        const failures = pendingBackgroundWriteErrors.splice(0)
        throw new AggregateError(failures, 'One or more background writes failed')
    }
}

async function runBackgroundUpdate(update: BackgroundUpdate, markSaved?: () => void): Promise<void> {
    const updateVersion = currentBackgroundRuntimeVersion()
    const data = await storage.sync.get('backgrounds')
    const local = await storage.local.get()

    if (!isCurrentBackgroundRuntimeVersion(updateVersion)) {
        return
    }

    data.backgrounds.query ??= ''
    local.backgroundCollections ??= {}

    if (update.blurenter) {
        await blurResolutionControl(data, local)
        return
    }

    if (update.blur !== undefined) {
        const blur = Number.parseFloat(update.blur)
        applyFilters({ blur })
        queueBackgroundProperties({ blur })
        return
    }

    if (update.bright !== undefined) {
        const bright = Number.parseFloat(update.bright)
        applyFilters({ bright })
        queueBackgroundProperties({ bright })
        return
    }

    if (isBackgroundType(update.type)) {
        data.backgrounds.type = update.type
        unlockBackgroundFrequency(data.backgrounds)

        if (update.type === 'images' && update.provider !== undefined) {
            const previousProvider = data.backgrounds.images
            data.backgrounds.images = update.provider

            if (previousProvider !== update.provider) {
                data.backgrounds.query = ''
            }
        }

        await saveBackgroundPatch({
            type: data.backgrounds.type,
            frequency: data.backgrounds.frequency,
            ...(update.type === 'images' && update.provider !== undefined
                ? { ...backgroundSourcePatch('images', update.provider), query: data.backgrounds.query }
                : {}),
        })
        markSaved?.()
        handleBackgroundOptions(data.backgrounds)
        backgroundsInit(data, local)
        return
    }

    if (isFrequency(update.freq)) {
        data.backgrounds.frequency = update.freq

        if (update.freq === 'pause') {
            const collection = getCollection(data.backgrounds, local).images()
            data.backgrounds.pausedImage = collection[0]
        } else {
            delete data.backgrounds.pausedImage
        }

        await saveBackgroundPatch({
            frequency: data.backgrounds.frequency,
            pausedImage: data.backgrounds.pausedImage,
        })
        markSaved?.()
        handleBackgroundOptions(data.backgrounds)
    }

    if (update.refresh) {
        if (data.backgrounds.type === 'images') {
            await backgroundCacheControl(data.backgrounds, local, true)
        }

        turnRefreshButton(update.refresh, true)
    }

    if (update.color) {
        colorInput('solid-background', update.color)
        const unlocked = unlockBackgroundFrequency(data.backgrounds)

        if (unlocked) {
            data.backgrounds.color = update.color
            await saveBackgroundPatch({
                color: data.backgrounds.color,
                frequency: data.backgrounds.frequency,
                pausedImage: data.backgrounds.pausedImage,
            })
            markSaved?.()
        }

        applyBackground(update.color)
        colorUpdateDebounce(update.color, currentBackgroundRuntimeVersion())
    }

    // Textures

    if (update.texturecolor !== undefined) {
        data.backgrounds.texture.color = update.texturecolor
        queueBackgroundProperties({ texture: structuredClone(data.backgrounds.texture) })
        colorInput('texture-color', update.texturecolor)
        applyTexture(data.backgrounds.texture)
    }

    if (update.textureopacity !== undefined) {
        data.backgrounds.texture.opacity = Number.parseFloat(update.textureopacity)
        queueBackgroundProperties({ texture: structuredClone(data.backgrounds.texture) })
        applyTexture(data.backgrounds.texture)
    }

    if (update.texturesize !== undefined) {
        data.backgrounds.texture.size = Number.parseInt(update.texturesize)
        queueBackgroundProperties({ texture: structuredClone(data.backgrounds.texture) })
        applyTexture(data.backgrounds.texture)
    }

    if (isBackgroundTexture(update.texture)) {
        data.backgrounds.texture = { type: update.texture }
        await saveBackgroundPatch({ texture: data.backgrounds.texture })
        markSaved?.()
        handleBackgroundOptions(data.backgrounds)
        applyTexture(data.backgrounds.texture)
    }

    document.dispatchEvent(
        new CustomEvent('updateSettingsBeforeInit', {
            detail: data,
        }),
    )

    // Images only

    switch (data.backgrounds.type) {
        case 'color': {
            return
        }

        default:
    }

    if (update.provider) {
        unlockBackgroundFrequency(data.backgrounds)
        const previousProvider = data.backgrounds[data.backgrounds.type]
        const query = previousProvider === update.provider ? data.backgrounds.query : ''

        data.backgrounds[data.backgrounds.type] = update.provider
        data.backgrounds.query = query
        await saveBackgroundPatch({
            ...backgroundSourcePatch(data.backgrounds.type, update.provider),
            frequency: data.backgrounds.frequency,
            query,
        })
        markSaved?.()
        handleBackgroundOptions(data.backgrounds)

        const isNotEmpty = local.backgroundCollections[update.provider]?.length > 0
        const isDefault = update.provider === DEFAULT_IMAGE_COLLECTION

        if (isNotEmpty || isDefault) {
            void backgroundCacheControl(data.backgrounds, local).catch((err) => {
                console.warn('[Backgrounds] Cannot load selected background provider', err)
            })
        }
    }

    if (update.querydraft !== undefined) {
        const collectionName = queryCollectionName(update.querydraft.targetId, data.backgrounds)
        const query = update.querydraft.value

        data.backgrounds[data.backgrounds.type] = collectionName
        data.backgrounds.query = query

        await saveBackgroundPatch({
            ...backgroundSourcePatch(data.backgrounds.type, collectionName),
            query,
        })
        markSaved?.()
        handleBackgroundOptions(data.backgrounds)
    }

    if (update.query !== undefined) {
        const collectionName = queryCollectionName(update.query.targetId, data.backgrounds)
        let query = update.query.value

        // 0. extract unsplash collection from URL

        const isCorrectCollection = collectionName === 'unsplash-images-collections'
        const collectionUrlPrefix = 'https://unsplash.com/collections/'
        const startsWithUrl = query.startsWith(collectionUrlPrefix)
        if (isCorrectCollection && startsWithUrl) {
            query = query.slice(collectionUrlPrefix.length).split('/')[0] ?? ''
        }

        // 1. Save query

        unlockBackgroundFrequency(data.backgrounds)
        data.backgrounds[data.backgrounds.type] = collectionName
        local.backgroundCollections[collectionName] = []
        data.backgrounds.query = query

        await saveBackgroundPatch({
            ...backgroundSourcePatch(data.backgrounds.type, collectionName),
            frequency: data.backgrounds.frequency,
            query,
        })
        markSaved?.()

        // 2. Handle empty query

        if (query === '') {
            await storage.local.set({ backgroundCollections: local.backgroundCollections })

            formBackgroundUserColl.accept('')
            formBackgroundUserSearch.accept('')
            removeBackgrounds()

            return
        }

        const queryForm = update.query.targetId.includes('coll') ? formBackgroundUserColl : formBackgroundUserSearch
        const queryInputId = update.query.targetId.includes('coll')
            ? 'i_background-user-coll'
            : 'i_background-user-search'

        queryForm.load()

        handleBackgroundOptions(data.backgrounds)
        await backgroundCacheControl(data.backgrounds, local)

        queryForm.accept(queryInputId, query)
    }
}

function queueBackgroundProperties(patch: PendingBackgroundProperties): void {
    pendingBackgroundProperties = { ...pendingBackgroundProperties, ...patch }
    propertiesUpdateDebounce(structuredClone(pendingBackgroundProperties), currentBackgroundRuntimeVersion())
}

function tracksImmediateBackgroundWrite(update: BackgroundUpdate): boolean {
    return update.query !== undefined ||
        update.querydraft !== undefined ||
        update.provider !== undefined ||
        update.type !== undefined ||
        update.freq !== undefined ||
        update.color !== undefined ||
        update.refresh !== undefined ||
        update.texture !== undefined
}

function trackPendingBackgroundWrite(): { done: () => void; fail: (err: unknown) => void } {
    let resolve = (): void => {}
    let finished = false
    const promise = new Promise<void>((done) => {
        resolve = done
    })

    pendingBackgroundWrites.add(promise)
    promise.finally(() => pendingBackgroundWrites.delete(promise))

    return {
        done: () => {
            if (finished) {
                return
            }

            finished = true
            resolve()
        },
        fail: (err: unknown) => {
            if (!finished) {
                pendingBackgroundWriteErrors.push(err)
            }
        },
    }
}

function unlockBackgroundFrequency(backgrounds: Backgrounds): boolean {
    if (backgrounds.frequency !== 'pause') {
        return false
    }

    backgrounds.frequency = 'hour'
    delete backgrounds.pausedImage

    const frequencyInput = document.querySelector<HTMLSelectElement>('#i_freq')

    if (frequencyInput) {
        frequencyInput.value = backgrounds.frequency
    }

    handleBackgroundActions(backgrounds)

    return true
}

export async function filtersUpdate(
    { blur, bright, texture }: Partial<Backgrounds>,
    runtimeVersion = currentBackgroundRuntimeVersion(),
): Promise<void> {
    pendingBackgroundProperties = {}
    if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) {
        return
    }

    const data = await storage.sync.get('backgrounds')

    if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) {
        return
    }

    if (blur !== undefined) {
        data.backgrounds.blur = blur
    }
    if (bright !== undefined) {
        data.backgrounds.bright = bright
    }
    if (texture !== undefined) {
        data.backgrounds.texture = texture
    }

    await saveBackgroundPatch({
        ...(blur !== undefined ? { blur } : {}),
        ...(bright !== undefined ? { bright } : {}),
        ...(texture !== undefined ? { texture } : {}),
    }, runtimeVersion)
}

async function solidUpdate(value: string, runtimeVersion = currentBackgroundRuntimeVersion()): Promise<void> {
    if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) {
        return
    }

    const data = await storage.sync.get('backgrounds')

    if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) {
        return
    }

    data.backgrounds.color = value
    await saveBackgroundPatch({ color: value }, runtimeVersion)
}

async function saveBackgroundPatch(
    patch: BackgroundPatch,
    runtimeVersion = currentBackgroundRuntimeVersion(),
): Promise<Backgrounds> {
    let saved: Backgrounds | undefined

    const queuedPatch = backgroundPatchQueue.catch(() => {}).then(async () => {
        const latest = await storage.sync.get('backgrounds')

        // A destructive import/download/reset invalidates the runtime before
        // releasing the storage lock. Do not let an older async background
        // task wake up afterwards and patch the newly committed config.
        if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) {
            saved = latest.backgrounds
            return
        }
        const backgrounds = mergeBackgroundPatch(latest.backgrounds, patch)

        await storage.sync.set({ backgrounds })
        saved = backgrounds
    })

    backgroundPatchQueue = queuedPatch.then(() => {}, () => {})

    await queuedPatch

    return saved!
}

//	Cache & network

async function backgroundCacheControl(backgrounds: Backgrounds, local: Local, needNew?: boolean): Promise<void> {
    const runtimeVersion = currentBackgroundRuntimeVersion()

    if (backgrounds.type === 'color') {
        return
    }

    if (backgrounds.type === 'images' && backgrounds.frequency === 'pause' && backgrounds.pausedImage) {
        applyBackground(backgrounds.pausedImage)
        return
    }

    // 1. Find correct list to use

    let list: BackgroundImage[] = getCollection(backgrounds, local).images()

    // 2. Control change for specified list

    const lastTime = new Date(local.backgroundLastChange ?? '01/01/1971').getTime()
    const isPaused = backgrounds.frequency === 'pause'
    const isPreloading = isPreloadingActive()

    needNew ??= needsChange(backgrounds.frequency, lastTime)

    if (list.length === 0) {
        const json = await fetchNewBackgrounds(backgrounds, local)

        if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) return

        if (json) {
            const newlocal = setCollection(backgrounds, local).fromApi(json)
            const newcoll = getCollection(backgrounds, newlocal)

            newlocal.backgroundLastChange = userDate().toString()
            await storage.local.set({
                backgroundCollections: newlocal.backgroundCollections,
                backgroundLastChange: newlocal.backgroundLastChange,
            })

            if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) return

            list = newcoll.images()

            preloadBackground(list[1])
        }
    }

    if (list.length === 0) {
        showImageFallback(backgrounds.color)
        return
    }

    if (isPreloading) {
        applyBackground(list[0])
        preloadBackground(list[1])
        return
    }

    if (!needNew && isPaused) {
        if (backgrounds.pausedImage) {
            applyBackground(backgrounds.pausedImage)
            return
        }
    }

    if (!needNew) {
        applyBackground(list[0])
        return
    }

    if (list.length > 1) {
        list.shift()
    }

    if (backgrounds.frequency === 'pause') {
        backgrounds.pausedImage = list[0]
        await saveBackgroundPatch({ pausedImage: backgrounds.pausedImage }, runtimeVersion)
        if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) return
    }

    if (list.length > 1) {
        let newlocal = local

        preloadBackground(list[1])

        newlocal = setCollection(backgrounds, local).fromList(list)
        newlocal.backgroundLastChange = userDate().toString()
        await storage.local.set({
            backgroundCollections: newlocal.backgroundCollections,
            backgroundLastChange: newlocal.backgroundLastChange,
        })
        if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) return
    }

    // 3. Apply image and get a new set if needed

    applyBackground(list[0])

    if (list.length === 1 && navigator.onLine) {
        const json = await fetchNewBackgrounds(backgrounds, local)

        if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) return

        if (json) {
            const newlocal = setCollection(backgrounds, local).fromApi(json)
            const newcoll = getCollection(backgrounds, newlocal)
            const newlist = newcoll.images()

            preloadBackground(newlist[0])
            preloadBackground(newlist[1])

            await storage.local.set({ backgroundCollections: newlocal.backgroundCollections })
        }
    }
}

async function fetchNewBackgrounds(
    backgrounds: Backgrounds,
    local: Local,
): Promise<Record<string, Background[]> | null> {
    switch (backgrounds.type) {
        case 'color': {
            throw new Error('Can only fetch with "images" type')
        }

        default:
    }

    const collectionName = normalizedImageCollectionName(backgrounds.images)
    const accessKey = local.unsplashAccessKey

    if (!accessKey) {
        showUnsplashStatus('missing')
        return null
    }

    const density = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1))
    const screenWidth = Math.max(1, globalThis.screen.width)
    const screenHeight = Math.max(1, globalThis.screen.height)
    const ratio = screenWidth / screenHeight
    let height = screenHeight * density
    let width = screenWidth * density

    if (ratio >= 2) {
        width = height * 2
    }
    if (ratio <= 0.5) {
        height = width * 2
    }

    const scale = Math.min(1, Math.sqrt(MAX_BACKGROUND_REQUEST_PIXELS / (width * height)))
    height = Math.round(height * scale)
    width = Math.round(width * scale)

    const query = backgroundQueryValue(backgrounds, collectionName)

    if (
        (collectionName === 'unsplash-images-search' || collectionName === 'unsplash-images-collections') &&
        query.trim() === ''
    ) {
        return null
    }

    try {
        const source = collectionName === 'unsplash-images-search'
            ? { type: 'search' as const, query }
            : collectionName === 'unsplash-images-collections'
            ? { type: 'collection' as const, id: query }
            : { type: 'random' as const }
        const images = await fetchUnsplashPhotos({
            accessKey,
            source,
            width,
            height,
            count: UNSPLASH_BATCH_SIZE,
            timeoutMs: BACKGROUND_FETCH_TIMEOUT_MS,
        })
        showUnsplashStatus()
        return { [collectionName]: images }
    } catch (err) {
        const code = err instanceof UnsplashError ? err.code : 'network'
        showUnsplashStatus(code)
        console.warn(`[Backgrounds] Cannot fetch Unsplash collection (${code})`)
        return null
    }
}

function findCollectionName(backgrounds: Backgrounds, local: Local): string {
    switch (backgrounds.type) {
        case 'color': {
            throw new Error('Only collection names with "images" type')
        }

        default:
    }

    const { frequency, pausedImage } = backgrounds
    const isPausedOnImage = frequency === 'pause' && pausedImage

    if (isPausedOnImage) {
        return getCollectionNameFromMedia(pausedImage, local)
    }

    return normalizedImageCollectionName(backgrounds.images)
}

export function normalizedImageCollectionName(value: string): string {
    return UNSPLASH_COLLECTIONS.has(value) ? value : DEFAULT_IMAGE_COLLECTION
}

function getCollectionNameFromMedia(media: Background, local: Local): string {
    const collMap = new Map()
    const collections = local.backgroundCollections ?? {}

    // Flatten collections to a "url => coll" map

    for (const [coll, medias] of Object.entries(collections)) {
        for (const media of medias) {
            collMap.set(media.urls.full, coll)
        }
    }

    return collMap.get(media.urls.full)
}

function getCollection(backgrounds: Backgrounds, local: Local): CollectionGetReturn {
    switch (backgrounds.type) {
        case 'color': {
            throw new Error('Can only fetch with "images" type')
        }

        default:
    }

    // Check collection storage

    const collectionName = findCollectionName(backgrounds, local)
    const collection = local.backgroundCollections?.[collectionName] ?? []

    // Check collection format

    const images = (): BackgroundImage[] => {
        if (areOnlyImages(collection)) {
            return collection.filter(isTrackableUnsplashImage)
        }
        throw new Error('Wrong background format')
    }

    return { images }
}

function setCollection(backgrounds: Backgrounds, local: Local): CollectionSetReturn {
    switch (backgrounds.type) {
        case 'color': {
            throw new Error('Cannot update with this type')
        }

        default:
    }

    function fromApi(json: Record<string, Background[]>): Local {
        local.backgroundCollections ??= {}

        for (const [key, list] of Object.entries(json)) {
            local.backgroundCollections[key] = list
        }

        return local
    }

    function fromList(list: Background[]): Local {
        const collectionName = findCollectionName(backgrounds, local)
        local.backgroundCollections ??= {}
        local.backgroundCollections[collectionName] = list

        return local
    }

    return { fromList, fromApi }
}

// 	Apply to DOM

export function applyBackground(media?: string | Background, res?: BackgroundSize, fast?: 'fast'): void {
    const mediaWrapper = document.getElementById('background-media') as HTMLDivElement
    let resolution = res ? res : detectBackgroundSize()

    if (typeof media === 'string') {
        invalidateBackgroundRuntime()
        Array.from(mediaWrapper?.children ?? []).forEach(releaseBackgroundNode)
        document.getElementById('background-wrapper')?.classList.remove('hidden')
        document.getElementById('background-wrapper')?.setAttribute('data-type', 'color')
        document.documentElement.style.setProperty('--solid-background', media)
        document.documentElement.style.setProperty('--average-color', media)
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', media)
        settingsBackgroundColor(media)
        localStorage.removeItem('backgroundCache')
        return
    }

    if (fast) {
        document.body.classList.add('init')
    }

    if (!media) {
        return
    }

    if (isTrackableUnsplashImage(media)) {
        document.getElementById('background-wrapper')?.setAttribute('data-type', 'images')
    }

    // disables blur compression for animated gifs (flawed since some gifs aren't animated)
    resolution = media.mimetype === 'image/gif' ? 'full' : resolution
    const src = media.urls[resolution]
    releaseUnusedObjectUrls(media, src)
    const runtimeVersion = currentBackgroundRuntimeVersion()
    const item = createImageItem(src, media, runtimeVersion, () => {
        retirePreviousBackgrounds(mediaWrapper, item, fast)
    })

    item.dataset.res = resolution
    if (src.startsWith('blob:')) {
        item.dataset.objectUrl = src
    }
    mediaWrapper.prepend(item)
}

function createImageItem(
    src: string,
    media: BackgroundImage,
    runtimeVersion: number,
    callback?: () => void,
): HTMLDivElement {
    const backgroundsWrapper = document.getElementById('background-wrapper')
    const div = document.createElement('div')
    const img = new Image()
    let settled = false
    const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        releaseBackgroundNode(div)
        img.remove()
        document.body.classList.remove('init')
    }, BACKGROUND_IMAGE_LOAD_TIMEOUT_MS)

    const onImageReady = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (!isCurrentBackgroundRuntimeVersion(runtimeVersion) || !div.isConnected) {
            releaseBackgroundNode(div)
            return
        }

        const isSmall = img.width <= 256 && img.height <= 256
        const isPng = !!media.mimetype?.includes('png')

        div?.classList.toggle('pixelated', isPng && isSmall)
        backgroundsWrapper?.classList.remove('hidden')
        applyThemeColor(media, img)
        updateCredits(media)
        void trackSelectedUnsplashPhoto(media)
        if (src.startsWith('blob:')) {
            localStorage.removeItem('backgroundCache')
        } else {
            localStorage.setItem('backgroundCache', src)
        }

        if (callback) {
            callback()
        }
    }

    div.classList.add('background-image')
    div.style.backgroundImage = `url(${src})`

    queueMicrotask(() => {
        img.addEventListener('load', onImageReady)
        img.addEventListener('error', () => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            releaseBackgroundNode(div)
            document.body.classList.remove('init')
        }, { once: true })
        img.src = src

        // If image is already cached, show it immediately without waiting for async load event.
        // This must run after applyBackground() prepends `div`; otherwise cached images can
        // finish while `div.isConnected` is still false and get mistaken for stale loads.
        if (img.complete && img.naturalWidth > 0) {
            img.removeEventListener('load', onImageReady)
            onImageReady()
        }

        img.remove()
    })

    return div
}

async function trackSelectedUnsplashPhoto(media: BackgroundImage): Promise<void> {
    if (!isTrackableUnsplashImage(media)) return

    try {
        const local = await storage.local.get([
            'unsplashAccessKey',
            'backgroundLastTrackedPhoto',
        ])
        const accessKey = local.unsplashAccessKey

        if (!accessKey || local.backgroundLastTrackedPhoto === media.id) return

        await trackUnsplashDownload(media.download, accessKey, { timeoutMs: BACKGROUND_FETCH_TIMEOUT_MS })
        await storage.local.set({ backgroundLastTrackedPhoto: media.id })
    } catch (err) {
        const code = err instanceof UnsplashError ? err.code : 'network'
        showUnsplashStatus(code)
        console.warn(`[Backgrounds] Cannot record Unsplash background selection (${code})`)
    }
}

function isTrackableUnsplashImage(media: BackgroundImage): media is BackgroundImage & { id: string; download: string } {
    return typeof media.id === 'string' && /^[A-Za-z0-9_-]+$/.test(media.id) &&
        safeUnsplashDownloadLocation(media.download) !== undefined
}

function showImageFallback(color: string): void {
    removeBackgrounds()
    updateCredits()

    const wrapper = document.getElementById('background-wrapper')
    wrapper?.setAttribute('data-type', 'color')
    wrapper?.classList.remove('hidden')
    document.documentElement.style.setProperty('--solid-background', color)
    document.documentElement.style.setProperty('--average-color', color)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
    settingsBackgroundColor(color)
}

function showUnsplashStatus(code?: UnsplashError['code']): void {
    const status = document.getElementById('unsplash-access-key-status')
    const required = document.getElementById('unsplash-access-key-required')

    if (required) required.classList.toggle('shown', code === 'missing')
    if (!status) return

    const message = code === 'invalid'
        ? 'Enter a valid Unsplash Access Key.'
        : code === 'rate-limit'
        ? 'Unsplash rate limit reached. Try again later.'
        : code === 'network'
        ? 'Could not reach Unsplash. Cached backgrounds remain available.'
        : code === 'response'
        ? 'Unsplash returned an invalid response.'
        : ''

    status.textContent = message ? tradThis(message) : ''
    status.classList.toggle('shown', message !== '')
    status.classList.toggle('error', message !== '')
    status.classList.remove('success')
}

function retirePreviousBackgrounds(mediaWrapper: HTMLDivElement, current: HTMLDivElement, fast?: 'fast'): void {
    document.body.classList.remove('init')
    const previous = Array.from(mediaWrapper.children).filter((node) => node !== current)
    const delay = fast ? 200 : 1200

    for (const node of previous) {
        if (!fast) {
            node.classList.add('hiding')
        }
        setTimeout(() => releaseBackgroundNode(node), delay)
    }
}

function releaseUnusedObjectUrls(media: BackgroundImage, selected: string): void {
    const urls = new Set(Object.values(media.urls).filter((url): url is string => typeof url === 'string'))

    for (const url of urls) {
        if (url !== selected && url.startsWith('blob:')) {
            URL.revokeObjectURL(url)
        }
    }
}

function releaseBackgroundNode(node: Element): void {
    const objectUrl = (node as HTMLElement).dataset.objectUrl

    if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        delete (node as HTMLElement).dataset.objectUrl
    }
    node.remove()
}

// 写时间戳而不是裸布尔：用户在 preload 中途关掉 tab 时，原本的 'true'
// 标志会永远卡死，后续每个新 tab 都会跳过 needsChange 判断、永远不切图。
// 改成时间戳后，超过 PRELOAD_FLAG_TTL_MS 视为 stale 自动失效。
const PRELOAD_FLAG_KEY = 'backgroundPreloadingAt'
const PRELOAD_FLAG_TTL_MS = 30_000
let preloadGeneration = 0

function isPreloadingActive(): boolean {
    const raw = localStorage.getItem(PRELOAD_FLAG_KEY)
    if (!raw) return false
    const ts = Number(raw.split(':')[0])
    if (!Number.isFinite(ts) || Date.now() - ts > PRELOAD_FLAG_TTL_MS) {
        localStorage.removeItem(PRELOAD_FLAG_KEY)
        return false
    }
    return true
}

function preloadBackground(media: Background | undefined, res?: BackgroundSize): void | Promise<unknown> {
    if (!media) {
        return
    }

    const marker = `${Date.now()}:${++preloadGeneration}`
    localStorage.setItem(PRELOAD_FLAG_KEY, marker)

    const resolution = res ? res : detectBackgroundSize()
    const src = media.urls[resolution]
    const img = document.createElement('img')
    img.fetchPriority = 'low'

    return new Promise((resolve) => {
        let settled = false
        let timeout = 0
        const cleanup = () => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            if (localStorage.getItem(PRELOAD_FLAG_KEY) === marker) {
                localStorage.removeItem(PRELOAD_FLAG_KEY)
            }
            img.remove()
            resolve(true)
        }
        timeout = setTimeout(cleanup, BACKGROUND_IMAGE_LOAD_TIMEOUT_MS)

        img.addEventListener('load', cleanup, { once: true })
        img.addEventListener('error', cleanup, { once: true })
        img.src = src
    })
}

export function removeBackgrounds(): void {
    const mediaWrapper = document.getElementById('background-media') as HTMLDivElement
    const backgrounds = Array.from(mediaWrapper?.children ?? [])

    for (const background of backgrounds) {
        background.classList.add('hiding')
        setTimeout(() => releaseBackgroundNode(background), 2000)
    }
    localStorage.removeItem('backgroundCache')
}

function applyFilters({ blur, bright }: Partial<Backgrounds>): void {
    if (blur !== undefined) {
        document.documentElement.style.setProperty('--blur', `${blur}px`)
        document.body.classList.toggle('blurred', blur >= 15)
    }

    if (bright !== undefined) {
        document.documentElement.style.setProperty('--brightness', `${bright}`)
    }
}

function applyTexture(texture: Backgrounds['texture']): void {
    const wrapper = document.getElementById('background-wrapper')
    const domtexture = document.getElementById('background-texture')

    if (!(domtexture && wrapper)) {
        return
    }

    const ranges = TEXTURE_RANGES[texture.type]
    const color = texture.color ?? ranges.color
    const size = texture.size ?? ranges.size.value
    const opacity = texture.opacity ?? ranges.opacity.value

    wrapper.dataset.texture = texture.type
    document.documentElement.style.setProperty('--texture-color', `${color}`)
    document.documentElement.style.setProperty('--texture-color-transparent', `${color}77`)
    document.documentElement.style.setProperty('--texture-opacity', `${opacity}`)
    document.documentElement.style.setProperty('--texture-size', `${size}px`)
}

// 	Settings options

export function initBackgroundOptions(sync: Sync): void {
    handleBackgroundOptions(sync.backgrounds)
    handleProviderOptions(sync.backgrounds)
}

function handleBackgroundOptions(backgrounds: Backgrounds): void {
    const type = backgrounds.type
    const isUnsplash = type === 'images'

    document.getElementById('solid_options')?.classList.toggle('shown', type === 'color')
    document.getElementById('background-freq-option')?.classList.toggle('shown', isUnsplash)
    document.getElementById('background-filters-options')?.classList.toggle('shown', isUnsplash)

    handleTextureOptions(backgrounds)
    handleProviderOptions(backgrounds)
    handleBackgroundActions(backgrounds)
}

function handleTextureOptions(backgrounds: Backgrounds): void {
    const hasTexture = backgrounds.texture.type !== 'none'

    document.getElementById('background-texture-options')?.classList.toggle('shown', hasTexture)

    if (hasTexture) {
        const iOpacity = document.querySelector<HTMLInputElement>('#i_texture-opacity')
        const iSize = document.querySelector<HTMLInputElement>('#i_texture-size')
        const colorOption = document.querySelector<HTMLElement>('#background-texture-color-option')

        const ranges = TEXTURE_RANGES[backgrounds.texture.type]
        const { opacity, size } = backgrounds.texture

        // shows and hides texture color option
        colorOption?.classList.toggle('shown', ranges.color !== undefined)

        if (iOpacity) {
            iOpacity.min = ranges.opacity.min
            iOpacity.max = ranges.opacity.max
            iOpacity.step = ranges.opacity.step
            iOpacity.value = opacity === undefined ? ranges.opacity.value : opacity.toString()
            webkitRangeTrackColor(iOpacity)
        }

        if (iSize) {
            iSize.min = ranges.size.min
            iSize.max = ranges.size.max
            iSize.step = ranges.size.step
            iSize.value = size === undefined ? ranges.size.value : size.toString()
            webkitRangeTrackColor(iSize)
        }
    }
}

let lastShownCollectionName = ''

function handleProviderOptions(backgrounds: Backgrounds): void {
    toggleCredits(backgrounds)

    if (backgrounds.type !== 'images') {
        document.getElementById('background-user-coll-option')?.classList.remove('shown')
        document.getElementById('background-user-search-option')?.classList.remove('shown')
        return
    }

    const collectionName = normalizedImageCollectionName(backgrounds.images)
    const hasCollections = collectionName.includes('coll')
    const hasSearch = collectionName.includes('search')

    const domusercoll = document.querySelector<HTMLInputElement>('#i_background-user-coll')
    const domusersearch = document.querySelector<HTMLInputElement>('#i_background-user-search')
    const domusercolloption = document.querySelector<HTMLElement>('#background-user-coll-option')
    const domusersearchoption = document.querySelector<HTMLElement>('#background-user-search-option')
    const optionsExist = domusercoll && domusersearch && domusercolloption && domusersearchoption

    if (optionsExist) {
        domusercolloption.classList.toggle('shown', hasCollections)
        domusersearchoption.classList.toggle('shown', hasSearch)

        if (collectionName !== lastShownCollectionName) {
            domusercoll.value = hasCollections ? backgrounds.query : ''
            domusersearch.value = hasSearch ? backgrounds.query : ''
            lastShownCollectionName = collectionName
        }
    }
}

async function blurResolutionControl(sync: Sync, local: Local): Promise<void> {
    const runtimeVersion = currentBackgroundRuntimeVersion()

    const [current, next] = await getCurrentBackgrounds(sync, local)
    if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) return

    preloadBackground(current, 'small')

    preloadBackground(current, 'full')?.then(() => {
        if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) return
        applyBackground(current, 'full', 'fast')
        preloadBackground(next, 'full')
    })
}

//  Helpers

function getCurrentBackgrounds(sync: Sync, local: Local): [Background, Background] | [] {
    if (sync.backgrounds.frequency === 'pause' && sync.backgrounds.pausedImage) {
        const lists = getCollection(sync.backgrounds, local)
        const images = lists.images()
        return [sync.backgrounds.pausedImage, images[0]]
    }
    if (sync.backgrounds.type === 'images') {
        const lists = getCollection(sync.backgrounds, local)
        const images = lists.images()
        return [images[0], images[1]]
    }

    return []
}

function detectBackgroundSize(): 'full' | 'small' {
    return document.body.className.includes('blurred') ? 'small' : 'full'
}

function applyThemeColor(image: BackgroundImage, img: HTMLImageElement): void {
    let color = image.color

    if (!color) {
        // 跨域图未声明 crossOrigin 时 canvas 会被 taint，getAverageColor 内的
        // getImageData 抛 SecurityError 被吞掉。这里就当主题色提取失败，跳过；
        // 强行加 crossOrigin 反而会让没返回 ACAO 的图源直接加载失败。
        color = getAverageColor(img)
    }

    if (color) {
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
        document.documentElement.style.setProperty('--average-color', color)
        settingsBackgroundColor(color)
    }
}

function getAverageColor(img: HTMLImageElement): undefined | string {
    try {
        // Create a canvas element
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')

        // resizing the image for better performance
        const maxDimension = 100

        // Calculate the scaling factor to maintain aspect ratio
        const scale = Math.min(maxDimension / img.width, maxDimension / img.height)

        // Set canvas dimensions to the scaled image dimensions
        canvas.width = img.width * scale
        canvas.height = img.height * scale

        // Draw the image onto the canvas
        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height)

        // Get the image data from the canvas
        const imageData = ctx?.getImageData(0, 0, canvas.width, canvas.height)
        const data = imageData?.data

        let r = 0
        let g = 0
        let b = 0
        let count = 0

        // Loop through the image data and sum the color values
        if (data) {
            for (let i = 0; i < data.length; i += 4) {
                r += data[i]
                g += data[i + 1]
                b += data[i + 2]
                count++
            }
        }

        // Calculate the average color
        r = Math.floor(r / count)
        g = Math.floor(g / count)
        b = Math.floor(b / count)

        // Output the average color in RGB format
        return rgbToHex(r, g, b)
    } catch (_error) {
        //...
    }
}

function isBackgroundType(str = ''): str is Sync['backgrounds']['type'] {
    return ['images', 'color'].includes(str)
}
function isBackgroundTexture(str = ''): str is Sync['backgrounds']['texture']['type'] {
    return [
        'none',
        'grain',
        'verticalDots',
        'diagonalDots',
        'topographic',
        'checkerboard',
        'isometric',
        'grid',
        'verticalLines',
        'horizontalLines',
        'diagonalStripes',
        'verticalStripes',
        'horizontalStripes',
        'diagonalLines',
        'aztec',
        'circuitBoard',
        'ticTacToe',
        'endlessClouds',
        'vectorGrain',
        'waves',
        'honeycomb',
    ].includes(str)
}
function isFrequency(str = ''): str is Frequency {
    return ['tabs', 'hour', 'day', 'period', 'pause'].includes(str)
}

export function isBackgroundImage(value: unknown): value is BackgroundImage {
    if (!isRecord(value) || value.format !== 'image' || !isRecord(value.urls)) return false
    return typeof value.urls.full === 'string' && typeof value.urls.small === 'string'
}

function areOnlyImages(list: unknown): list is BackgroundImage[] {
    return Array.isArray(list) && list.every(isBackgroundImage)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

export const __testing = {
    normalizedImageCollectionName,
    trackSelectedUnsplashPhoto,
}

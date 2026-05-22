import { applyUrls, getUrlsAsCollection, initUrlsEditor, urlsCacheControl } from './urls.ts'
import { handleBackgroundActions, initBackgroundActionsEvents } from '../contextmenu.ts'
import { settingsBackgroundColor } from '../others.ts'
import { toggleCredits, updateCredits } from './credits.ts'
import { TEXTURE_RANGES } from './textures.ts'
import { PROVIDERS } from './providers.ts'
import {
    addLocalBackgrounds,
    initFilesSettingsOptions,
    lastUsedBackgroundFiles,
    localFilesCacheControl,
    mediaFromFiles,
} from './local.ts'

import { colorInput, turnRefreshButton, webkitRangeTrackColor } from '../../shared/dom.ts'
import { daylightPeriod, needsChange, userDate } from '../../shared/time.ts'
import { networkForm } from '../../shared/form.ts'
import { rgbToHex } from '../../shared/generic.ts'
import { debounce } from '../../utils/debounce.ts'
import { storage } from '../../storage.ts'

import type { Background, BackgroundImage, Frequency } from '../../../types/shared.ts'
import type { Backgrounds, Sync } from '../../../types/sync.ts'
import type { Local } from '../../../types/local.ts'

type BackgroundSize = 'full' | 'small'

interface CollectionGetReturn {
    images: () => BackgroundImage[]
}

interface CollectionSetReturn {
    fromList: (list: Background[]) => Local
    fromApi: (json: Record<string, Background[]>) => Local
}

interface BackgroundUpdate {
    freq?: string
    type?: string
    blur?: string
    blurenter?: true
    color?: string
    query?: SubmitEvent
    files?: FileList | null
    bright?: string
    refresh?: Event
    urlsapply?: true
    texture?: string
    provider?: string
    texturecolor?: string
    texturesize?: string
    textureopacity?: string
}

const propertiesUpdateDebounce = debounce(filtersUpdate, 600)
const colorUpdateDebounce = debounce(solidUpdate, 600)
const formBackgroundUserColl = networkForm('f_background-user-coll')
const formBackgroundUserSearch = networkForm('f_background-user-search')

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
    }

    toggleCredits(sync.backgrounds)
    applyFilters(sync.backgrounds)
    applyTexture(sync.backgrounds.texture)
    handleBackgroundActions(sync.backgrounds)
    document.getElementById('background-wrapper')?.setAttribute('data-type', sync.backgrounds.type)

    switch (sync.backgrounds.type) {
        case 'files': {
            localFilesCacheControl(sync.backgrounds, local)
            break
        }
        case 'urls': {
            urlsCacheControl(sync.backgrounds, local)
            break
        }
        case 'color': {
            applyBackground(sync.backgrounds.color)
            break
        }
        default: {
            backgroundCacheControl(sync.backgrounds, local)
        }
    }
}

// 	Storage update

export async function backgroundUpdate(update: BackgroundUpdate): Promise<void> {
    const data = await storage.sync.get('backgrounds')
    const local = await storage.local.get()

    data.backgrounds.queries ??= {}
    local.backgroundCollections ??= {}
    local.backgroundFiles ??= {}

    if (update.blurenter) {
        blurResolutionControl(data, local)
        return
    }

    if (update.blur !== undefined) {
        applyFilters({ blur: Number.parseFloat(update.blur) })
        propertiesUpdateDebounce({ blur: Number.parseFloat(update.blur) })
        return
    }

    if (update.bright !== undefined) {
        applyFilters({ bright: Number.parseFloat(update.bright) })
        propertiesUpdateDebounce({ bright: Number.parseFloat(update.bright) })
        return
    }

    if (isBackgroundType(update.type)) {
        data.backgrounds.type = update.type
        storage.sync.set({ backgrounds: data.backgrounds })
        createProviderSelect(data.backgrounds)
        handleBackgroundOptions(data.backgrounds)
        backgroundsInit(data, local)
        return
    }

    if (isFrequency(update.freq)) {
        data.backgrounds.frequency = update.freq

        if (update.freq === 'pause') {
            const type = data.backgrounds.type

            if (type === 'images') {
                const collection = getCollection(data.backgrounds, local).images()
                data.backgrounds.pausedImage = collection[0]
            }
            if (type === 'urls') {
                const [_, list] = getUrlsAsCollection(local)
                data.backgrounds.pausedUrl = list[0].urls.full
            }
        }

        storage.sync.set({ backgrounds: data.backgrounds })
        handleBackgroundOptions(data.backgrounds)
    }

    if (update.refresh) {
        switch (data.backgrounds.type) {
            case 'files': {
                localFilesCacheControl(data.backgrounds, local, true)
                break
            }
            case 'urls': {
                urlsCacheControl(data.backgrounds, local, true)
                break
            }
            case 'images': {
                backgroundCacheControl(data.backgrounds, local, true)
                break
            }
        }

        turnRefreshButton(update.refresh, true)
    }

    if (update.color) {
        colorInput('solid-background', update.color)
        applyBackground(update.color)
        colorUpdateDebounce(update.color)
    }

    if (update.urlsapply) {
        applyUrls(data.backgrounds)
    }

    if (update.files) {
        addLocalBackgrounds(update.files, local)
    }

    // Textures

    if (update.texturecolor !== undefined) {
        data.backgrounds.texture.color = update.texturecolor
        propertiesUpdateDebounce({ texture: data.backgrounds.texture })
        colorInput('texture-color', update.texturecolor)
        applyTexture(data.backgrounds.texture)
    }

    if (update.textureopacity !== undefined) {
        data.backgrounds.texture.opacity = Number.parseFloat(update.textureopacity)
        propertiesUpdateDebounce({ texture: data.backgrounds.texture })
        applyTexture(data.backgrounds.texture)
    }

    if (update.texturesize !== undefined) {
        data.backgrounds.texture.size = Number.parseInt(update.texturesize)
        propertiesUpdateDebounce({ texture: data.backgrounds.texture })
        applyTexture(data.backgrounds.texture)
    }

    if (isBackgroundTexture(update.texture)) {
        data.backgrounds.texture = { type: update.texture }
        storage.sync.set({ backgrounds: data.backgrounds })
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
        case 'files':
        case 'urls':
        case 'color': {
            return
        }

        default:
    }

    if (update.provider) {
        data.backgrounds[data.backgrounds.type] = update.provider
        storage.sync.set({ backgrounds: data.backgrounds })
        handleBackgroundOptions(data.backgrounds)

        const isNotEmpty = local.backgroundCollections[update.provider]?.length > 0
        const isDefault = update.provider.includes('bonjourr')

        if (isNotEmpty || isDefault) {
            backgroundCacheControl(data.backgrounds, local)
        }
    }

    if (update.query !== undefined) {
        const collectionName = data.backgrounds[data.backgrounds.type]
        const target = update.query.target as HTMLElement
        const input = target.querySelector<HTMLInputElement>('input')
        let query = input?.value ?? ''

        // 0. extract unsplash collection from URL

        const isCorrectCollection = collectionName === 'unsplash-images-collections'
        const startsWithUrl = query.startsWith('https://unsplash.com/collections/')
        if (isCorrectCollection && startsWithUrl) {
            query = query.replace('https://unsplash.com/collections/', '').slice(0, query.indexOf('/'))
        }

        // 1. Save query

        local.backgroundCollections[collectionName] = []
        data.backgrounds.queries[collectionName] = query
        storage.sync.set({ backgrounds: data.backgrounds })

        // 2. Handle empty query

        if (query === '') {
            storage.local.set({ backgroundCollections: local.backgroundCollections })

            formBackgroundUserColl.accept('')
            formBackgroundUserSearch.accept('')
            removeBackgrounds()

            return
        }

        formBackgroundUserColl.load()
        formBackgroundUserSearch.load()

        handleBackgroundOptions(data.backgrounds)
        await backgroundCacheControl(data.backgrounds, local)

        formBackgroundUserColl.accept(collectionName)
        formBackgroundUserSearch.accept(collectionName)
    }
}

export async function filtersUpdate({ blur, bright, texture }: Partial<Backgrounds>): Promise<void> {
    const data = await storage.sync.get('backgrounds')

    if (blur !== undefined) {
        data.backgrounds.blur = blur
    }
    if (bright !== undefined) {
        data.backgrounds.bright = bright
    }
    if (texture !== undefined) {
        data.backgrounds.texture = texture
    }

    storage.sync.set({ backgrounds: data.backgrounds })
}

async function solidUpdate(value: string): Promise<void> {
    const data = await storage.sync.get('backgrounds')
    data.backgrounds.color = value
    storage.sync.set({ backgrounds: data.backgrounds })
}

//	Cache & network

async function backgroundCacheControl(backgrounds: Backgrounds, local: Local, needNew?: boolean): Promise<void> {
    if (backgrounds.type === 'color') {
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
        const json = await fetchNewBackgrounds(backgrounds)

        if (json) {
            const newlocal = setCollection(backgrounds, local).fromApi(json)
            const newcoll = getCollection(backgrounds, newlocal)

            newlocal.backgroundLastChange = userDate().toString()
            storage.local.set(newlocal)

            list = newcoll.images()

            preloadBackground(list[1])
        }
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
        storage.sync.set({ backgrounds })
    }

    if (list.length > 1) {
        let newlocal = local

        preloadBackground(list[1])

        newlocal = setCollection(backgrounds, local).fromList(list)
        newlocal.backgroundLastChange = userDate().toString()
        storage.local.set(newlocal)
    }

    // 3. Apply image and get a new set if needed

    applyBackground(list[0])

    if (list.length === 1 && navigator.onLine) {
        const json = await fetchNewBackgrounds(backgrounds)

        if (json) {
            const newlocal = setCollection(backgrounds, local).fromApi(json)
            const newcoll = getCollection(backgrounds, newlocal)
            const newlist = newcoll.images()

            preloadBackground(newlist[0])
            preloadBackground(newlist[1])

            storage.local.set({ backgroundCollections: newlocal.backgroundCollections })
        }
    }
}

async function fetchNewBackgrounds(backgrounds: Backgrounds): Promise<Record<string, Background[]> | null> {
    switch (backgrounds.type) {
        case 'files':
        case 'urls':
        case 'color': {
            throw new Error('Can only fetch with "images" type')
        }

        default:
    }

    const defaultCollection = 'bonjourr-images-daylight'
    const collectionName = backgrounds[backgrounds.type] || defaultCollection
    const [provider, type, category] = collectionName.split('-')

    if (!provider || !type || !category) {
        console.warn(`[Backgrounds] Invalid collection name: "${collectionName}"`)
        return null
    }

    const base = 'https://services.bonjourr.fr/backgrounds'
    const path = `/${provider}/${type}/${category}`

    const density = Math.max(2, globalThis.devicePixelRatio)
    const ratio = globalThis.screen.width / globalThis.screen.height
    let height = globalThis.screen.height * density
    let width = globalThis.screen.width * density

    if (ratio >= 2) {
        width = height * 2
    }
    if (ratio <= 0.5) {
        height = width * 2
    }

    const screen = `?h=${height}&w=${width}`
    const query = backgrounds.queries?.[collectionName] ?? ''
    const search = query ? `&query=${query}` : ''

    const url = base + path + screen + search
    const resp = await fetch(url)

    if (!resp.ok) {
        console.warn(`[Backgrounds] Cannot fetch collection (${resp.status}): ${url}`)
        return null
    }

    const contentType = resp.headers.get('content-type') ?? ''

    if (!contentType.includes('application/json')) {
        const body = await resp.text()
        console.warn(`[Backgrounds] Unexpected response type: ${contentType || 'unknown'} (${body.slice(0, 120)})`)
        return null
    }

    const json = await resp.json()

    const areImages = type === 'images' && Object.keys(json)?.every((key) => key.includes('images'))

    if (areImages) {
        return json
    }

    throw new Error('Received JSON is bad')
}

function findCollectionName(backgrounds: Backgrounds, local: Local): string {
    switch (backgrounds.type) {
        case 'files':
        case 'urls':
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

    const defaultCollection = 'bonjourr-images-daylight'
    const collectionName = backgrounds.images || defaultCollection
    const isDaylight = collectionName.includes('daylight')

    if (isDaylight) {
        const period = daylightPeriod(userDate().getTime())
        return `${collectionName}-${period}`
    }

    return collectionName
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
        case 'files':
        case 'urls':
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
            return collection
        }
        throw new Error('Wrong background format')
    }

    return { images }
}

function setCollection(backgrounds: Backgrounds, local: Local): CollectionSetReturn {
    switch (backgrounds.type) {
        case 'files':
        case 'urls':
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
        mediaWrapper?.childNodes.forEach((node) => node.remove())
        document.documentElement.style.setProperty('--solid-background', media)
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

    // disables blur compression for animated gifs (flawed since some gifs aren't animated)
    resolution = media.mimetype === 'image/gif' ? 'full' : resolution
    const src = media.urls[resolution]
    const item = createImageItem(src, media)

    item.dataset.res = resolution
    mediaWrapper.prepend(item)

    if (mediaWrapper?.childElementCount > 1) {
        const children = Object.values(mediaWrapper?.children)
        const notHiding = children.filter((child) => !child.className.includes('hiding'))
        const lastVisible = notHiding.at(-1)

        if (fast) {
            document.body.classList.remove('init')
            setTimeout(() => mediaWrapper?.lastElementChild?.remove(), 200)
        } else {
            lastVisible?.classList.add('hiding')
            setTimeout(() => mediaWrapper?.lastElementChild?.remove(), 1200)
        }
    }
}

function createImageItem(src: string, media: BackgroundImage, callback?: () => void): HTMLDivElement {
    const backgroundsWrapper = document.getElementById('background-wrapper')
    const div = document.createElement('div')
    const img = new Image()

    const onImageReady = () => {
        const isSmall = img.width <= 256 && img.height <= 256
        const isPng = !!media.mimetype?.includes('png')

        div?.classList.toggle('pixelated', isPng && isSmall)
        backgroundsWrapper?.classList.remove('hidden')
        applyThemeColor(media, img)
        updateCredits(media)
        localStorage.setItem('backgroundCache', src)

        if (callback) {
            callback()
        }
    }

    img.addEventListener('load', onImageReady)
    img.src = src

    // If image is already cached, show it immediately without waiting for async load event
    if (img.complete && img.naturalWidth > 0) {
        img.removeEventListener('load', onImageReady)
        onImageReady()
    }

    img.remove()

    div.classList.add('background-image')
    div.style.backgroundImage = `url(${src})`

    if (media?.file?.position) {
        const { size, x, y } = media.file.position

        div.style.backgroundSize = size
        div.style.backgroundPositionX = x
        div.style.backgroundPositionY = y
    }

    return div
}

// 写时间戳而不是裸布尔：用户在 preload 中途关掉 tab 时，原本的 'true'
// 标志会永远卡死，后续每个新 tab 都会跳过 needsChange 判断、永远不切图。
// 改成时间戳后，超过 PRELOAD_FLAG_TTL_MS 视为 stale 自动失效。
const PRELOAD_FLAG_KEY = 'backgroundPreloadingAt'
const PRELOAD_FLAG_TTL_MS = 30_000

function isPreloadingActive(): boolean {
    const raw = localStorage.getItem(PRELOAD_FLAG_KEY)
    if (!raw) return false
    const ts = Number(raw)
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

    localStorage.setItem(PRELOAD_FLAG_KEY, Date.now().toString())

    const resolution = res ? res : detectBackgroundSize()
    const src = media.urls[resolution]
    const img = document.createElement('img')
    img.fetchPriority = 'low'

    return new Promise((resolve) => {
        const cleanup = () => {
            localStorage.removeItem(PRELOAD_FLAG_KEY)
            img.remove()
            resolve(true)
        }

        img.addEventListener('load', cleanup)
        img.addEventListener('error', cleanup)
        img.src = src
    })
}

export function removeBackgrounds(): void {
    const mediaWrapper = document.getElementById('background-media') as HTMLDivElement
    setTimeout(() => document.querySelector('#background-media div')?.classList.add('hiding'))
    setTimeout(() => mediaWrapper.firstChild?.remove(), 2000)
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

export function initBackgroundOptions(sync: Sync, local: Local): void {
    initFilesSettingsOptions(local)
    initUrlsEditor(sync.backgrounds, local)
    createProviderSelect(sync.backgrounds)
    handleBackgroundOptions(sync.backgrounds)
}

function handleBackgroundOptions(backgrounds: Backgrounds): void {
    const type = backgrounds.type
    document.getElementById('local_options')?.classList.toggle('shown', type === 'files')
    document.getElementById('solid_options')?.classList.toggle('shown', type === 'color')
    document.getElementById('unsplash_options')?.classList.toggle('shown', type === 'images')
    document.getElementById('background-urls-option')?.classList.toggle('shown', type === 'urls')
    document.getElementById('background-freq-option')?.classList.toggle('shown', type !== 'color')
    document.getElementById('background-filters-options')?.classList.toggle('shown', type !== 'color')

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
    switch (backgrounds.type) {
        case 'files':
        case 'urls':
        case 'color': {
            document.getElementById('background-provider-option')?.classList.remove('shown')
            return
        }

        default:
    }

    document.getElementById('background-provider-option')?.classList.add('shown')

    const collectionName = backgrounds[backgrounds.type]
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
            domusercoll.value = backgrounds.queries?.[collectionName] ?? ''
            domusersearch.value = backgrounds.queries?.[collectionName] ?? ''
            lastShownCollectionName = collectionName
        }
    }
}

function createProviderSelect(backgrounds: Backgrounds): void {
    const backgroundProvider = document.querySelector<HTMLSelectElement>('#i_background-provider')
    const providersList = PROVIDERS.IMAGES

    if (!backgroundProvider) {
        throw new Error('Cannot find #i_background-provider')
    }

    for (const node of Object.values(backgroundProvider.children)) {
        node.remove()
    }

    for (const provider of providersList) {
        const optgroup = document.createElement('optgroup')
        optgroup.label = provider.optgroup
        backgroundProvider?.appendChild(optgroup)

        for (const option of provider.options) {
            const opt = document.createElement('option')
            opt.textContent = option.name
            opt.value = option.value
            optgroup.appendChild(opt)
        }
    }

    if (backgrounds.type === 'images') {
        backgroundProvider.value = backgrounds.images
    }
}

async function blurResolutionControl(sync: Sync, local: Local): Promise<void> {
    if (sync.backgrounds.type === 'files') {
        const ids = lastUsedBackgroundFiles(local.backgroundFiles)
        const image = await mediaFromFiles(ids[0], local)
        applyBackground(image, 'full')
        return
    }

    const [current, next] = await getCurrentBackgrounds(sync, local)

    preloadBackground(current, 'small')

    preloadBackground(current, 'full')?.then(() => {
        applyBackground(current, 'full', 'fast')
        preloadBackground(next, 'full')
    })
}

//  Helpers

async function getCurrentBackgrounds(sync: Sync, local: Local): Promise<[Background, Background] | []> {
    if (sync.backgrounds.type === 'files') {
        const ids = lastUsedBackgroundFiles(local.backgroundFiles)
        const current = await mediaFromFiles(ids[0], local)
        const next = await mediaFromFiles(ids[1], local)
        return [current, next]
    }
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
    return ['files', 'urls', 'images', 'color'].includes(str)
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

function areOnlyImages(list: Background[]): list is BackgroundImage[] {
    return list?.every((item) => item.format === 'image')
}

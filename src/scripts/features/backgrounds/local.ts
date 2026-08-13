import { applyBackground, removeBackgrounds } from './index.ts'
import { compressAsBlob, imageDimensions } from '../../shared/compress.ts'
import { webkitRangeTrackColor } from '../../shared/dom.ts'
import { needsChange } from '../../shared/time.ts'
import { onclickdown } from '../../utils/clickdown.ts'
import { IS_MOBILE } from '../../defaults.ts'
import { getCache } from '../../shared/cache.ts'
import { storage } from '../../storage.ts'
import { currentBackgroundRuntimeVersion, isCurrentBackgroundRuntimeVersion } from './cache.ts'

import type { Background, BackgroundImage } from '../../../types/shared.ts'
import type { BackgroundFile, Local } from '../../../types/local.ts'
import type { Backgrounds } from '../../../types/sync.ts'

type LocalFileData = {
    full: Blob
    small: Blob
}

interface LocalBackgroundEntry {
    id: string
    file: File
}

type LocalFileOption =
    | 'size'
    | 'vertical'
    | 'horizontal'
    | 'use-compressed'

let thumbnailVisibilityObserver: IntersectionObserver
let thumbnailSelectionObserver: MutationObserver
const THUMBNAIL_LOAD_TIMEOUT_MS = 15_000

// Update

export async function addLocalBackgrounds(filelist: FileList | File[], local: Local): Promise<void> {
    try {
        const thumbnailsContainer = document.getElementById('thumbnails-container')
        const filesData: Record<string, LocalFileData> = {}
        const newEntries = await uniqueLocalBackgroundEntries(filelist, local.backgroundFiles)
        const newids = newEntries.map(({ id }) => id)

        if (filelist.length === 0) {
            return
        }

        local.backgroundFiles ??= {}

        // 1. Add empty thumbnails

        for (const { id } of newEntries) {
            const thumbnail = createThumbnail(id)
            thumbnailsContainer?.appendChild(thumbnail)
            thumbnailSelectionObserver?.observe(thumbnail, { attributes: true })
        }

        if (thumbnailsContainer) {
            const idsAmount = Object.keys(local.backgroundFiles).length + newids.length
            const columnsAmount = Math.min(idsAmount, 5).toString()
            thumbnailsContainer.style.setProperty('--thumbnails-columns', columnsAmount)
        }

        // 2. Compress files for background & thumbnail use

        for (const { file, id } of newEntries) {
            // 2a. This finds a reasonable resolution for compression

            const isLandscape = globalThis.screen.orientation?.type?.startsWith('landscape') ??
                globalThis.screen.width >= globalThis.screen.height
            const long = isLandscape ? globalThis.screen.width : globalThis.screen.height
            const short = isLandscape ? globalThis.screen.height : globalThis.screen.width
            const density = Math.min(2, globalThis.devicePixelRatio)
            const ratio = Math.min(1.8, long / short)
            const averagePixelHeight = short * ratio * density

            const isGif = file.type.includes('image/gif')
            const isThumbnailSize = file.size < 80000 // 80 kb
            const isResonablySized = file.size < 300000 // 300 kb

            let full: Blob = file
            let small: Blob = file

            if (!isThumbnailSize) {
                const objectUrl = URL.createObjectURL(file)
                try {
                    const dimensions = await imageDimensions(objectUrl)
                    const width = dimensions.width
                    const height = dimensions.height
                    const isHighRes = averagePixelHeight * 2 < width + height
                    const isCompressible = !isGif && !isResonablySized && isHighRes

                    if (isCompressible) {
                        full = await compressAsBlob(objectUrl, { size: averagePixelHeight, q: 0.8 })
                    }

                    small = await compressAsBlob(objectUrl, { size: 360, q: 0.4 })
                } finally {
                    URL.revokeObjectURL(objectUrl)
                }
            }

            local.backgroundFiles[id] = {
                lastUsed: new Date().toString(),
                position: {
                    size: 'cover',
                    x: '50%',
                    y: '50%',
                },
            }

            filesData[id] = {
                full,
                small,
            }

            await saveFileToCache(id, filesData[id])
            addThumbnailImage(id, filesData[id])

            await storage.local.set({ backgroundFiles: local.backgroundFiles })
        }

        // 3. Apply background

        if (newids.length > 0) {
            const id = newids[0]
            const media = await mediaFromFiles(id, local, filesData[id])

            applyBackground(media)
            unselectAll()

            document.getElementById(id)?.classList.add('selected')
        }

        // 4. Allow same file to be uploaded

        const uploadInput = document.querySelector<HTMLInputElement>('#i_background-upload')

        if (uploadInput) {
            uploadInput.value = ''
        }
    } catch (e) {
        console.info(e)
        throw e
    }
}

async function removeLocalBackgrounds(): Promise<void> {
    try {
        const local = await storage.local.get()
        const selectedIds = getSelection()

        if (selectedIds.length === 0 || !local.backgroundFiles) {
            return
        }

        for (const id of selectedIds) {
            const nextFiles = { ...local.backgroundFiles }
            delete nextFiles[id]
            await storage.local.set({ backgroundFiles: nextFiles })

            try {
                await removeFilesFromCache([id])
            } catch (error) {
                await storage.local.set({ backgroundFiles: local.backgroundFiles })
                throw error
            }
            local.backgroundFiles = nextFiles

            const thumbnail = document.querySelector<HTMLElement>(`#${id}`)
            thumbnail?.classList.toggle('hiding', true)
            setTimeout(() => {
                thumbnail?.remove()
                toggleFileButtons()
            }, 100)
        }

        const filesIds = lastUsedBackgroundFiles(local.backgroundFiles)

        if (filesIds.length > 0) {
            applyBackground(await mediaFromFiles(filesIds[0], local))
        } else {
            removeBackgrounds()
        }

        handleFilesSettingsOptions(local)
    } catch (err) {
        console.warn('Cannot remove local background', err)
        throw err
    }
}

async function updateFileOptions(option: LocalFileOption, value: string): Promise<void> {
    const selection = getSelection()[0]
    const local = await storage.local.get('backgroundFiles')
    const file = local.backgroundFiles[selection]

    const backgroundImage = document.querySelector<HTMLElement>('#background-media div')

    if (!file) {
        console.error('Cannot find file')
        return
    }

    if (backgroundImage) {
        if (!file.position) {
            file.position = {
                size: 'cover',
                x: '50%',
                y: '50%',
            }
        }

        if (option === 'size') {
            file.position.size = value === '100' ? 'cover' : `${value}%`
            backgroundImage.style.backgroundSize = file.position.size
        }
        if (option === 'vertical') {
            file.position.y = `${value}%`
            backgroundImage.style.backgroundPositionY = file.position.y
        }
        if (option === 'horizontal') {
            file.position.x = `${value}%`
            backgroundImage.style.backgroundPositionX = file.position.x
        }
        if (option === 'use-compressed') {
            applyBackground(await mediaFromFiles(selection, local, undefined, file))
        }
    }

    local.backgroundFiles[selection] = file
    await storage.local.set({ backgroundFiles: local.backgroundFiles })
}

//	Settings options

export function initFilesSettingsOptions(local: Local): void {
    if (IS_MOBILE) {
        const container = document.getElementById('thumbnails-container')
        container?.style.setProperty('--thumbnails-columns', '2')
    }

    sanitizeMetadatas(local).then((newlocal) => {
        handleFilesSettingsOptions(newlocal)
    }).catch((err) => {
        console.warn('[Backgrounds] Cannot sanitize local background metadata', err)
    })

    onclickdown(document.getElementById('b_thumbnail-remove'), () => {
        void removeLocalBackgrounds().catch((err) => console.warn('[Backgrounds] Cannot remove local background', err))
    })
    onclickdown(document.getElementById('b_thumbnail-options'), toggleFileOptions)
    document.getElementById('b_thumbnail-zoom')?.addEventListener('click', handleGridView)
    document.getElementById('i_background-size')?.addEventListener('input', fileOptionsEvent)
    document.getElementById('i_background-vertical')?.addEventListener('input', fileOptionsEvent)
    document.getElementById('i_background-horizontal')?.addEventListener('input', fileOptionsEvent)
    document.getElementById('i_background-compress')?.addEventListener('change', fileOptionsEvent)

    thumbnailSelectionObserver = new MutationObserver(toggleFileButtons)
    thumbnailVisibilityObserver = new IntersectionObserver(renderThumbnailOnIntersection)

    // option functions

    function fileOptionsEvent(this: HTMLInputElement): void {
        const { id, value, checked } = this

        if (id === 'i_background-size') {
            void updateFileOptions('size', value).catch(reportFileOptionError)
        }
        if (id === 'i_background-vertical') {
            void updateFileOptions('vertical', value).catch(reportFileOptionError)
        }
        if (id === 'i_background-horizontal') {
            void updateFileOptions('horizontal', value).catch(reportFileOptionError)
        }
        if (id === 'i_background-compress') {
            void updateFileOptions('use-compressed', checked.toString()).catch(reportFileOptionError)
        }
    }

    function reportFileOptionError(err: unknown): void {
        console.warn('[Backgrounds] Cannot update local background options', err)
    }

    function renderThumbnailOnIntersection(entries: IntersectionObserverEntry[]): void {
        for (const { target, isIntersecting } of entries) {
            const isLoading = target.classList.contains('loading')
            const id = target.id ?? ''

            if (isIntersecting && isLoading) {
                getFileFromCache(id).then((data) => {
                    addThumbnailImage(id, data)
                    thumbnailVisibilityObserver.unobserve(target)
                }).catch((err) => {
                    console.warn(`[Backgrounds] Cannot render local thumbnail ${id}`, err)
                })
            }
        }
    }

    function handleGridView(): void {
        const container = document.getElementById('thumbnails-container') as HTMLElement
        const currentZoom = globalThis.getComputedStyle(container).getPropertyValue('--thumbnails-columns')
        const newZoom = Math.max((Number.parseInt(currentZoom) + 1) % 6, 1)
        container.style.setProperty('--thumbnails-columns', newZoom.toString())
    }

    function toggleFileOptions(): void {
        document.getElementById('background-file-options')?.classList.toggle('shown')
    }
}

function handleFilesSettingsOptions(local: Local): void {
    const backgroundFiles = local.backgroundFiles
    const thumbnailsContainer = document.getElementById('thumbnails-container')
    const thumbs = document.querySelectorAll<HTMLElement>('.thumbnail')
    const thumbIds = Object.values(thumbs).map((el) => el.id)
    const fileIds = Object.keys(backgroundFiles) ?? []
    const lastUsedIds = lastUsedBackgroundFiles(local.backgroundFiles)
    const missingThumbnails = fileIds.filter((id) => !thumbIds.includes(id))
    const file = local.backgroundFiles[lastUsedIds[0]]

    if (missingThumbnails.length > 0) {
        for (const id of missingThumbnails) {
            const thumbnail = createThumbnail(id)
            thumbnailsContainer?.appendChild(thumbnail)
            thumbnailVisibilityObserver?.observe(thumbnail)
            thumbnailSelectionObserver?.observe(thumbnail, { attributes: true })

            if (id === lastUsedIds[0]) {
                thumbnail.classList.add('selected')
            }
        }
    }

    if (!file) {
        toggleFileButtons()
        return
    }

    const domSize = document.querySelector<HTMLInputElement>('#i_background-size')
    const domVertical = document.querySelector<HTMLInputElement>('#i_background-vertical')
    const domHorizontal = document.querySelector<HTMLInputElement>('#i_background-horizontal')
    const imageRangesExist = domSize && domVertical && domHorizontal

    const imageDefaults: BackgroundFile['position'] = { size: 'cover', x: '50%', y: '50%' }

    if (imageRangesExist) {
        const pos = file.position ?? imageDefaults

        domSize.value = (pos.size === 'cover' ? '100' : pos.size).replace('%', '')
        domVertical.value = pos.y.replace('%', '')
        domHorizontal.value = pos.x.replace('%', '')

        webkitRangeTrackColor(domSize)
        webkitRangeTrackColor(domVertical)
        webkitRangeTrackColor(domHorizontal)
    }

    toggleFileButtons()
}

function toggleFileButtons(): void {
    const thmbRemove = document.getElementById('b_thumbnail-remove')
    const thmbOptions = document.getElementById('b_thumbnail-options')
    const selected = document.querySelectorAll('.thumbnail.selected').length
    const domoptions = document.getElementById('background-options-options')
    const areOptionsShown = domoptions?.classList.contains('shown')

    selected === 0 ? thmbRemove?.setAttribute('disabled', '') : thmbRemove?.removeAttribute('disabled')
    selected !== 1 ? thmbOptions?.setAttribute('disabled', '') : thmbOptions?.removeAttribute('disabled')

    if (selected !== 1) {
        document.getElementById('background-file-options')?.classList.remove('shown')
    }
    if (selected === 1 && areOptionsShown) {
        domoptions?.classList.remove('shown')
    }
}

// Thumbnails

function createThumbnail(id: string): HTMLButtonElement {
    const thb = document.createElement('button')
    const thbimg = document.createElement('img')

    thb.id = id
    thb.className = 'thumbnail loading'
    thb.setAttribute('aria-label', 'Select this background')

    thbimg.src = 'src/assets/interface/loading.svg'
    thbimg.setAttribute('alt', '')
    thbimg.setAttribute('draggable', 'false')

    thb.appendChild(thbimg)
    thb.addEventListener('click', (event) => {
        void handleThumbnailClick.call(thb, event).catch((err) => {
            console.warn(`[Backgrounds] Cannot select local background ${id}`, err)
        })
    })

    return thb
}

function addThumbnailImage(id: string, data: LocalFileData): void {
    const btn = document.querySelector<HTMLButtonElement>(`#${id}`)
    const img = document.querySelector<HTMLImageElement>(`#${id} img`)

    if (!img || !btn) {
        console.warn('Cannot find thumbnail or button for ' + id)
        return
    }

    const objectUrl = URL.createObjectURL(data.small)
    let released = false
    const releaseObjectUrl = (): void => {
        if (released) {
            return
        }
        released = true
        clearTimeout(timeout)
        URL.revokeObjectURL(objectUrl)
    }
    const timeout = setTimeout(releaseObjectUrl, THUMBNAIL_LOAD_TIMEOUT_MS)

    img.addEventListener('load', () => {
        btn.classList.replace('loading', 'loaded')
        setTimeout(() => btn.classList.remove('loaded'), 2)
        releaseObjectUrl()
    }, { once: true })
    img.addEventListener('error', releaseObjectUrl, { once: true })
    img.src = objectUrl
}

async function handleThumbnailClick(this: HTMLButtonElement, mouseEvent: MouseEvent): Promise<void> {
    const hasCtrl = mouseEvent.ctrlKey || mouseEvent.metaKey
    const shiftKey = mouseEvent.shiftKey
    const isLeftClick = mouseEvent.button === 0
    const id = this?.id ?? ''

    if (isLeftClick && shiftKey) {
        const thumbnails = document.querySelectorAll('.thumbnail')

        let firstSelectionPos: number | undefined
        let lastSelectionPos: number | undefined
        let selectedPos: number | undefined

        // Find current selection range

        thumbnails.forEach((thumbnail, index) => {
            const isSelected = thumbnail.className.includes('selected')
            const isSelection = thumbnail === this

            if (isSelected) {
                lastSelectionPos = index
            }
            if (isSelected && !firstSelectionPos) {
                firstSelectionPos = index
            }
            if (isSelection && !selectedPos) {
                selectedPos = index
            }
        })

        // Increase range to maximum selected

        if (firstSelectionPos !== undefined && lastSelectionPos !== undefined && selectedPos !== undefined) {
            const positions = [firstSelectionPos, lastSelectionPos, selectedPos]
            const first = Math.min(...positions)
            const last = Math.max(...positions)

            thumbnails.forEach((thumbnail, index) => {
                const inSelectionRange = index >= first && index <= last
                thumbnail.classList.toggle('selected', inSelectionRange)
            })

            return
        }
    }

    if (isLeftClick && hasCtrl) {
        if (!this.classList.contains('selected')) {
            document.getElementById('b_thumbnail-remove')?.removeAttribute('disabled')
        }

        document.getElementById(id)?.classList?.toggle('selected')
        return
    }

    if (this.classList.contains('selected') && isLeftClick) {
        unselectAll()
        document.getElementById(id)?.classList?.toggle('selected')
        return
    }

    if (this.classList.contains('selected')) {
        return
    }

    if (isLeftClick) {
        const local = await storage.local.get()
        const metadata = local.backgroundFiles[id]
        const image = await mediaFromFiles(id, local)

        if (!metadata || !image) {
            console.warn('metadata: ', metadata)
            console.warn('image: ', image)
            return
        }

        unselectAll()
        document.getElementById(id)?.classList?.add('selected')

        local.backgroundFiles[id].lastUsed = new Date().toString()
        await storage.local.set({ backgroundFiles: local.backgroundFiles })

        handleFilesSettingsOptions(local)
        applyBackground(image)
    }
}

// Local to Background conversions

export function lastUsedBackgroundFiles(metadatas: Local['backgroundFiles']): string[] {
    const sortedMetadata = Object.entries(metadatas).toSorted((a, b) => {
        return new Date(b[1].lastUsed).getTime() - new Date(a[1].lastUsed).getTime()
    })

    return sortedMetadata.map(([id, _]) => id)
}

export async function mediaFromFiles(
    id: string,
    local: Local,
    data?: LocalFileData,
    metadata?: BackgroundFile,
): Promise<Background> {
    metadata ??= local.backgroundFiles[id]

    data = data ?? (await getFileFromCache(id))

    const fullUrl = URL.createObjectURL(data.full)
    let smallUrl: string

    try {
        smallUrl = URL.createObjectURL(data.small)
    } catch (err) {
        URL.revokeObjectURL(fullUrl)
        throw err
    }

    const image: BackgroundImage = {
        format: 'image',
        mimetype: data.full.type,
        file: metadata,
        urls: {
            full: fullUrl,
            small: smallUrl,
        },
    }

    return image
}

//	Helpers

function unselectAll(): void {
    for (const node of document.querySelectorAll('.thumbnail.selected')) {
        node?.classList?.remove('selected')
    }
}

function getSelection(): string[] {
    const thmbs = document.querySelectorAll<HTMLElement>('.thumbnail.selected')
    const ids = Object.values(thmbs).map((thmb) => thmb?.id ?? '')
    return ids
}

export async function localFilesCacheControl(backgrounds: Backgrounds, local: Local, needNew?: boolean): Promise<void> {
    const runtimeVersion = currentBackgroundRuntimeVersion()
    local = await sanitizeMetadatas(local)

    if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) {
        return
    }

    const ids = lastUsedBackgroundFiles(local.backgroundFiles)

    if (ids.length === 0) {
        removeBackgrounds()
        return
    }

    const freq = backgrounds.frequency
    const metadata = local.backgroundFiles[ids[0]]
    const lastUsed = new Date(metadata.lastUsed).getTime()

    needNew ??= needsChange(freq, lastUsed)

    if (ids.length > 1 && needNew) {
        ids.shift()

        const rand = Math.floor(Math.random() * ids.length)
        const id = ids[rand]

        const media = await mediaFromFiles(id, local)

        if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) {
            revokeBackgroundObjectUrls(media)
            return
        }

        applyBackground(media)
        local.backgroundFiles[id].lastUsed = new Date().toString()
        await storage.local.set({ backgroundFiles: local.backgroundFiles })
    } else {
        const media = await mediaFromFiles(ids[0], local)

        if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) {
            revokeBackgroundObjectUrls(media)
            return
        }

        applyBackground(media)
    }
}

function revokeBackgroundObjectUrls(media: Background): void {
    for (const url of Object.values(media.urls)) {
        if (url?.startsWith('blob:')) {
            URL.revokeObjectURL(url)
        }
    }
}

//  Storage

export async function saveFileToCache(id: string, filedata: LocalFileData): Promise<void> {
    const cache = await getCache('local-files')
    const { full, small } = filedata

    // Dumb down code from loop to force small/full

    const requestFull = new Request(`http://127.0.0.1:8888/${id}/full`)
    const requestSmall = new Request(`http://127.0.0.1:8888/${id}/small`)
    const headersFull = { 'content-type': full.type, 'Cache-Control': 'max-age=604800' }
    const headersSmall = { 'content-type': small.type, 'Cache-Control': 'max-age=604800' }
    const responseFull = new Response(full, { headers: headersFull })
    const responseSmall = new Response(small, { headers: headersSmall })

    const writes = await Promise.allSettled([
        cache.put(requestFull, responseFull),
        cache.put(requestSmall, responseSmall),
    ])

    const failures = writes.filter((result) => result.status === 'rejected')
    if (failures.length > 0) {
        await Promise.allSettled([
            cache.delete(requestFull),
            cache.delete(requestSmall),
        ])
        throw new AggregateError(failures.map((failure) => failure.reason), `Cannot cache local background ${id}`)
    }
}

export async function getFileFromCache(id: string): Promise<LocalFileData> {
    const cache = await getCache('local-files')
    const [fullResponse, smallResponse] = await Promise.all([
        cache.match(`http://127.0.0.1:8888/${id}/full`),
        cache.match(`http://127.0.0.1:8888/${id}/small`),
    ])
    const [full, small] = await Promise.all([
        fullResponse?.blob(),
        smallResponse?.blob(),
    ])

    if (!full || !small) {
        throw new Error(`${id} is undefined`)
    }

    return { full, small }
}

export async function removeFilesFromCache(ids: string[]): Promise<void> {
    const cache = await getCache('local-files')
    const deletions: Promise<boolean>[] = []

    for (const id of ids) {
        sessionStorage.removeItem(id)
        deletions.push(
            cache.delete(`http://127.0.0.1:8888/${id}/full`),
            cache.delete(`http://127.0.0.1:8888/${id}/small`),
        )
    }

    await Promise.all(deletions)
}

/**
 * Removes metadata in local storage or add default based on files
 * found in CacheStorage "local-files"
 */
export async function sanitizeMetadatas(local: Local): Promise<Local> {
    const newMetadataList: Record<string, BackgroundFile> = {}
    const cache = await getCache('local-files')
    const cacheKeys = await cache.keys()
    const cachedParts = new Map<string, Set<string>>()

    local.backgroundFiles ??= {}

    for (const request of cacheKeys) {
        try {
            const [key, part] = new URL(request.url).pathname.split('/').filter(Boolean)

            if (!key || (part !== 'full' && part !== 'small')) {
                continue
            }

            const parts = cachedParts.get(key) ?? new Set<string>()
            parts.add(part)
            cachedParts.set(key, parts)
        } catch (err) {
            console.info(err)
        }
    }

    for (const [key, parts] of cachedParts) {
        if (!(parts.has('full') && parts.has('small'))) {
            const availablePart = parts.has('full') ? 'full' : 'small'
            const missingPart = availablePart === 'full' ? 'small' : 'full'
            const availableRequest = new Request(`http://127.0.0.1:8888/${key}/${availablePart}`)
            const missingRequest = new Request(`http://127.0.0.1:8888/${key}/${missingPart}`)

            // Both cache entries contain the same user-selected image at
            // different sizes. If a browser evicted only one, retain the
            // irreplaceable remaining blob and rebuild the missing half.
            try {
                const available = await cache.match(availableRequest)
                if (!available) throw new Error(`Cannot read cached ${availablePart} background`)
                await cache.put(missingRequest, available.clone())
                parts.add(missingPart)
            } catch (err) {
                console.warn(`[Backgrounds] Cannot repair local background ${key}`, err)
            }
        }

        let metadata = local.backgroundFiles[key]

        if (!metadata) {
            metadata = {
                lastUsed: new Date('01/01/1971').toString(),
                position: {
                    size: 'cover',
                    x: '50%',
                    y: '50%',
                },
            }
        }

        // Keep metadata even if repair failed so a transient quota/cache
        // failure never turns into permanent user-data deletion.
        newMetadataList[key] = metadata
    }

    const oldKeys = Object.keys(local.backgroundFiles).toSorted()
    const newKeys = Object.keys(newMetadataList).toSorted()

    if (oldKeys.join('\n') !== newKeys.join('\n')) {
        await storage.local.set({ backgroundFiles: newMetadataList })
    }

    local.backgroundFiles = newMetadataList

    return local
}

export async function uniqueLocalBackgroundEntries(
    filelist: FileList | File[],
    existing: Local['backgroundFiles'],
): Promise<LocalBackgroundEntry[]> {
    const entries: LocalBackgroundEntry[] = []
    const knownIds = new Set(Object.keys(existing ?? {}))

    for (const file of filelist) {
        const id = await localBackgroundId(file)

        if (knownIds.has(id)) {
            continue
        }

        knownIds.add(id)
        entries.push({ id, file })
    }

    return entries
}

export async function localBackgroundId(file: File): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return `local-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

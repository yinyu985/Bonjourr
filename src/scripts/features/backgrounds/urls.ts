import { applyBackground, removeBackgrounds } from './index.ts'
import { backgroundUrlsFromText, currentBackgroundRuntimeVersion, isCurrentBackgroundRuntimeVersion } from './cache.ts'
import { stringMaxSize } from '../../shared/generic.ts'
import { needsChange } from '../../shared/time.ts'
import { storage } from '../../storage.ts'

import type { BackgroundUrl, BackgroundUrlState, Local } from '../../../types/local.ts'
import type { Background, BackgroundImage } from '../../../types/shared.ts'
import type { EditorOptions, PrismEditor } from 'prism-code-editor'
import type { Backgrounds } from '../../../types/sync.ts'

let globalUrlValue = ''
let backgroundUrlsEditor: PrismEditor
const URL_CHECK_TIMEOUT_MS = 8000
const URL_CHECK_CONCURRENCY = 4
let urlValidationVersion = 0

export async function urlsCacheControl(backgrounds: Backgrounds, local: Local, needNew?: boolean): Promise<void> {
    const runtimeVersion = currentBackgroundRuntimeVersion()
    await syncLocalUrlsFromConfig(backgrounds, local, runtimeVersion)

    if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) {
        return
    }

    if (backgrounds.frequency === 'pause' && backgrounds.pausedUrl) {
        applyBackground(urlAsBackgroundMedia(backgrounds.pausedUrl))
        return
    }

    const urls = lastUsedValidUrls(local.backgroundUrls ?? {})

    if (urls.length === 0) {
        removeBackgrounds()
        return
    }

    const url = urls[0]
    const freq = backgrounds.frequency
    const metadata = local.backgroundUrls[url]
    const lastUsed = new Date(metadata.lastUsed).getTime()

    needNew ??= needsChange(freq, lastUsed)

    if (urls.length > 1 && needNew) {
        urls.shift()

        const rand = Math.floor(Math.random() * urls.length)
        const url = urls[rand]
        const now = new Date().toString()
        const metadata = local.backgroundUrls[url]

        applyBackground(urlAsBackgroundMedia(url, metadata))
        local.backgroundUrls[url].lastUsed = now

        if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) {
            return
        }

        await storage.local.set({ backgroundUrls: local.backgroundUrls })
        return
    }

    applyBackground(urlAsBackgroundMedia(url, metadata))
}

async function syncLocalUrlsFromConfig(backgrounds: Backgrounds, local: Local, runtimeVersion: number): Promise<void> {
    const nextUrls = backgroundUrlsFromText(backgrounds.urls)
    const currentKeys = Object.keys(local.backgroundUrls ?? {}).toSorted()
    const nextKeys = Object.keys(nextUrls).toSorted()

    if (currentKeys.join('\n') === nextKeys.join('\n')) {
        return
    }

    for (const [url, metadata] of Object.entries(nextUrls)) {
        nextUrls[url] = local.backgroundUrls?.[url] ?? metadata
    }

    local.backgroundUrls = nextUrls

    if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) {
        return
    }

    await storage.local.set({ backgroundUrls: nextUrls })
}

export function lastUsedValidUrls(metadatas: Local['backgroundUrls']): string[] {
    const getTime = (item: BackgroundUrl) => new Date(item.lastUsed).getTime()
    const entries = Object.entries(metadatas)

    const sortedUrls = entries.toSorted((a, b) => getTime(b[1]) - getTime(a[1]))
    const validOnly = sortedUrls.filter(([_, metadata]) => metadata.state === 'OK')
    const urls = validOnly.map(([url, _]) => url)

    return urls
}

function urlAsBackgroundMedia(url: string, _metadata?: BackgroundUrl): Background {
    return {
        format: 'image',
        page: '',
        username: '',
        urls: {
            full: url,
            small: url,
        },
    }
}

export function getUrlsAsCollection(local: Local): [string[], BackgroundImage[]] {
    const entries = Object.entries(local.backgroundUrls ?? {})
    const working = entries.filter((entry) => entry[1].state === 'OK')
    const sorted = working.toSorted((a, b) => new Date(a[1].lastUsed).getTime() - new Date(b[1].lastUsed).getTime())
    const urls = sorted.map(([key]) => key)

    return [
        urls,
        urls.map((url) => ({
            format: 'image',
            page: '',
            username: '',
            urls: {
                full: url,
                medium: url,
                small: url,
            },
        })),
    ]
}

// Editor

export async function initUrlsEditor(backgrounds: Backgrounds, local: Local): Promise<void> {
    globalUrlValue = backgrounds.urls

    const { createBackgroundUrlsEditor } = await import('../csseditor.ts')

    const options: EditorOptions = {
        language: 'uri',
        value: backgrounds.urls,
    }

    backgroundUrlsEditor = createBackgroundUrlsEditor(options)

    const tabCommand = backgroundUrlsEditor.keyCommandMap.Tab

    backgroundUrlsEditor.textarea.id = 'background-urls-editor-textarea'
    backgroundUrlsEditor.textarea.maxLength = 8080
    backgroundUrlsEditor.textarea.placeholder = 'https://picsum.photos/200\n'

    backgroundUrlsEditor.on('update', (value) => {
        toggleUrlsButton(globalUrlValue, stringMaxSize(value, 8080))
    })

    backgroundUrlsEditor.keyCommandMap.Tab = (e, selection, value) => {
        if (document.body.matches('.tabbing')) {
            return false
        }

        return tabCommand?.(e, selection, value)
    }

    for (const [url, { state }] of Object.entries(local.backgroundUrls ?? {})) {
        highlightUrlsEditorLine(url, state)
    }
}

function highlightUrlsEditorLine(url: string, state: BackgroundUrlState): void {
    const lines = backgroundUrlsEditor.wrapper.querySelectorAll('.pce-line')
    const line = lines.values().find((l) => l.textContent === `${url}\n`)
    const noContent = !line?.textContent?.replace('\n', '')
    const lineState = noContent ? 'NONE' : state

    line?.classList.toggle('loading', lineState === 'LOADING')
    line?.classList.toggle('error', lineState === 'NOT_MEDIA')
    line?.classList.toggle('good', lineState === 'OK')
    line?.classList.toggle('warn', lineState === 'CANT_REACH' || lineState === 'NOT_URL')
}

export function toggleUrlsButton(storage: string, value: string): void {
    const button = document.querySelector<HTMLButtonElement>('#b_background-urls')

    if (storage === value) {
        button?.setAttribute('disabled', '')
    } else {
        button?.removeAttribute('disabled')
    }
}

export async function applyUrls(backgrounds: Backgrounds): Promise<void> {
    const editorValue = backgroundUrlsEditor.value
    const backgroundUrls: Local['backgroundUrls'] = backgroundUrlsFromText(editorValue, 'NONE')
    const validationVersion = ++urlValidationVersion
    const runtimeVersion = currentBackgroundRuntimeVersion()

    globalUrlValue = backgrounds.urls = editorValue
    await storage.sync.set({ backgrounds })

    if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) {
        return
    }

    await storage.local.set({ backgroundUrls })

    if (!isCurrentBackgroundRuntimeVersion(runtimeVersion)) {
        return
    }

    toggleUrlsButton('osef', 'osef')
    void checkUrlInfos(backgroundUrls, validationVersion, runtimeVersion).catch((err) => {
        console.warn('[Backgrounds] Cannot validate URL backgrounds', err)
    })
}

async function checkUrlInfos(
    backgroundUrls: Local['backgroundUrls'],
    validationVersion: number,
    runtimeVersion: number,
): Promise<void> {
    const entries = Object.entries(backgroundUrls)

    for (const [url] of entries) {
        highlightUrlsEditorLine(url, 'LOADING')
    }

    let nextIndex = 0
    const workers = Array.from({ length: Math.min(URL_CHECK_CONCURRENCY, entries.length) }, async () => {
        while (
            validationVersion === urlValidationVersion && isCurrentBackgroundRuntimeVersion(runtimeVersion) &&
            nextIndex < entries.length
        ) {
            const [url, item] = entries[nextIndex++]
            const state = await validateBackgroundUrl(url)

            // A newer Apply may have replaced the URL list while this network
            // request was in flight. Never let the stale result repaint the
            // editor or overwrite the newer metadata snapshot.
            if (validationVersion !== urlValidationVersion || !isCurrentBackgroundRuntimeVersion(runtimeVersion)) {
                return
            }

            item.state = state
            highlightUrlsEditorLine(url, item.state)
        }
    })

    await Promise.all(workers)

    if (
        validationVersion === urlValidationVersion && isCurrentBackgroundRuntimeVersion(runtimeVersion) &&
        entries.length > 0
    ) {
        await storage.local.set({ backgroundUrls })
    }
}

export async function validateBackgroundUrl(item: string): Promise<BackgroundUrlState> {
    let url: URL

    try {
        url = new URL(item)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return 'NOT_URL'
        }
    } catch (_) {
        return 'NOT_URL'
    }

    return await new Promise<BackgroundUrlState>((resolve) => {
        const image = new Image()
        let settled = false

        const finish = (state: BackgroundUrlState): void => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            image.onload = null
            image.onerror = null
            image.remove()
            resolve(state)
        }

        const timeout = setTimeout(() => finish('CANT_REACH'), URL_CHECK_TIMEOUT_MS)
        image.decoding = 'async'
        image.referrerPolicy = 'no-referrer'
        image.onload = () => finish(image.naturalWidth > 0 ? 'OK' : 'NOT_MEDIA')
        image.onerror = () => finish('CANT_REACH')
        image.src = url.href

        if (image.complete) {
            queueMicrotask(() => finish(image.naturalWidth > 0 ? 'OK' : 'NOT_MEDIA'))
        }
    })
}

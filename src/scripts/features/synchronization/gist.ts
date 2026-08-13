import { getLang, tradThis } from '../../utils/translations.ts'
import { stringify } from '../../utils/stringify.ts'
import { isStorageDefault, storage } from '../../storage.ts'
import { SyncNetworkError } from './errors.ts'

import type { Sync } from '../../../types/sync.ts'

interface GistItem {
    url: string
    forks_url: string
    commits_url: string
    id: string
    node_id: string
    git_pull_url: string
    git_push_url: string
    html_url: string
    files: Record<string, GistFile>
    public: boolean
}

interface GistFile {
    filename: string
    type: string
    language: string
    raw_url: string
    size: number
    content?: string
    truncated?: boolean
}

export function setGistStatusNow(gistId?: string, updatedAt = new Date().toISOString()): void {
    const wrapper = document.getElementById('gist-sync-status-wrapper')
    const base = document.getElementById('gist-sync-status-base') as HTMLSpanElement | null

    cachedStatus = undefined

    if (!wrapper || !base) {
        return
    }

    if (gistId) {
        renderStatus(wrapper, base, updatedAt, `https://gist.github.com/${gistId}`, gistId)
        return
    }

    renderStatusTime(wrapper, base, updatedAt)
}

// 节流：toggleSyncSettingsOption 在多处调用（settings 加载、改 token/url、切 syncType …），
// 每次都打一次 GitHub。短时间内反复点设置面板的人会暴打 API。
// 60s 内复用上次成功结果，不再 fetch。
const STATUS_FETCH_THROTTLE_MS = 60_000
let cachedStatus: { at: number; updatedAt: string; htmlUrl: string; key: string; resourceId: string } | undefined
let latestRenderedStatus: { resourceId: string; updatedAt: number } | undefined

export async function setGistStatus(token?: string, id?: string): Promise<boolean> {
    const wrapper = document.getElementById('gist-sync-status-wrapper') as HTMLElement
    const base = document.getElementById('gist-sync-status-base') as HTMLSpanElement

    if (!token) {
        document.querySelector('#gist-sync-status')?.remove()
        base.textContent = tradThis('Waiting for authentification')
        return false
    }

    if (!id) {
        document.querySelector('#gist-sync-status')?.remove()
        base.textContent = tradThis('No saved data yet')
        return false
    }

    const cacheKey = `${token}:${id}`
    const now = Date.now()

    if (cachedStatus && cachedStatus.key === cacheKey && now - cachedStatus.at < STATUS_FETCH_THROTTLE_MS) {
        renderStatus(wrapper, base, cachedStatus.updatedAt, cachedStatus.htmlUrl, cachedStatus.resourceId)
        return true
    }

    // autoSyncOnStartup 已经记过 remoteLastFetchedAt + remoteLastSyncedAt。
    // 用它们当 fallback 渲染：跨标签页打开 settings 也不需要再 fetch。
    const local = await storage.local.get(['remoteLastFetchedAt', 'remoteLastSyncedAt'])
    const fetchedAt = local.remoteLastFetchedAt
    const syncedAt = local.remoteLastSyncedAt
    const lastFetchedAt = fetchedAt ? new Date(fetchedAt).getTime() : 0
    const persistedHit = lastFetchedAt && now - lastFetchedAt < STATUS_FETCH_THROTTLE_MS

    if (persistedHit && syncedAt) {
        renderStatus(wrapper, base, syncedAt, `https://gist.github.com/${id}`, id)
        return true
    }

    let resp: Response

    try {
        resp = await fetchGistWithTimeout(`https://api.github.com/gists/${id}`, { headers: gistHeaders(token) })
    } catch (_) {
        document.querySelector('#gist-sync-status')?.remove()
        base.textContent = tradThis('Cannot connect to GitHub')
        return false
    }

    if (!resp.ok) {
        document.querySelector('#gist-sync-status')?.remove()
        base.textContent = tradThis('No saved data yet')
        return false
    }

    const json = await resp.json() as { updated_at: string; html_url: string }
    cachedStatus = { at: now, updatedAt: json.updated_at, htmlUrl: json.html_url, key: cacheKey, resourceId: id }
    void storage.local.set({
        remoteLastFetchedAt: new Date(now).toISOString(),
    }).catch((err) => {
        console.warn('Cannot persist GitHub status timestamp', err)
    })
    renderStatus(wrapper, base, json.updated_at, json.html_url, id)
    return true
}

function renderStatus(
    wrapper: HTMLElement,
    base: HTMLSpanElement,
    isoDate: string,
    htmlUrl: string,
    resourceId: string,
): void {
    if (shouldIgnoreStaleStatus(resourceId, isoDate)) {
        return
    }

    const dateString = new Date(isoDate).toLocaleString(getLang(), {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    })

    document.querySelector('#gist-sync-status')?.remove()

    const link = document.createElement('a')
    link.id = 'gist-sync-status'
    link.href = trustedGistPageUrl(htmlUrl, resourceId)
    link.rel = 'noopener noreferrer'
    link.target = '_blank'
    link.textContent = dateString

    wrapper?.appendChild(link)
    base.textContent = tradThis('Last update')
}

function trustedGistPageUrl(value: string, resourceId: string): string {
    try {
        const url = new URL(value)
        if (url.protocol === 'https:' && url.hostname === 'gist.github.com') return url.href
    } catch (_) {
        // Use the provider-owned fallback below.
    }
    return `https://gist.github.com/${encodeURIComponent(resourceId)}`
}

function renderStatusTime(wrapper: HTMLElement, base: HTMLSpanElement, isoDate: string): void {
    const dateString = new Date(isoDate).toLocaleString(getLang(), {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    })

    document.querySelector('#gist-sync-status')?.remove()

    const span = document.createElement('span')
    span.id = 'gist-sync-status'
    span.textContent = dateString
    wrapper.appendChild(span)
    base.textContent = tradThis('Last update')
}

function shouldIgnoreStaleStatus(resourceId: string, isoDate: string): boolean {
    const updatedAt = new Date(isoDate).getTime()

    if (Number.isNaN(updatedAt)) {
        return false
    }

    if (latestRenderedStatus?.resourceId === resourceId && updatedAt < latestRenderedStatus.updatedAt) {
        return true
    }

    latestRenderedStatus = { resourceId, updatedAt }
    return false
}

export interface GistRetrieveResult {
    sync: Sync
    updatedAt: string
}

export async function retrieveGist(token: string, id?: string): Promise<GistRetrieveResult> {
    type GistGet = {
        files: Record<string, GistFile | undefined>
        updated_at?: string
    }

    if (!token) {
        throw new Error(GIST_ERROR.TOKEN)
    }
    if (!id) {
        throw new Error(GIST_ERROR.ID)
    }

    const req = await gistFetch(`https://api.github.com/gists/${id}`, {
        headers: gistHeaders(token),
    })

    const gist = (await req.json()) as GistGet
    const file = gist?.files?.[GIST_FILENAME]
    let content = file?.content

    if ((file?.size ?? 0) > MAX_REMOTE_CONFIG_BYTES) {
        throw new Error(GIST_ERROR.JSON)
    }

    // GitHub truncates large Gist file bodies in the metadata response. Fetch
    // the authenticated raw URL explicitly rather than treating it as missing
    // or parsing partial JSON.
    if (file?.truncated) {
        if (!file.raw_url) throw new Error(GIST_ERROR.NOGIST)
        const rawUrl = trustedGistRawUrl(file.raw_url)
        const raw = await gistFetch(rawUrl, { headers: gistHeaders(token) })
        content = await raw.text()
    }

    if (
        !content || content.length > MAX_REMOTE_CONFIG_BYTES || !gist.updated_at || !isValidTimestamp(gist.updated_at)
    ) {
        throw new Error(GIST_ERROR.NOGIST)
    }

    try {
        return {
            sync: JSON.parse(content),
            updatedAt: gist.updated_at,
        }
    } catch (_) {
        throw new Error(GIST_ERROR.JSON)
    }
}

export async function fetchGistUpdatedAt(token: string, id: string): Promise<string | undefined> {
    if (!token || !id) {
        return
    }

    // 复用 gistFetch 的重试 + 超时逻辑，与 retrieveGist 一致；
    // 否则瞬时网络错误下这个函数会直接返回 undefined，
    // 调用方误以为远端没更新，紧接着 PATCH 上去覆盖远端。
    try {
        const resp = await gistFetch(`https://api.github.com/gists/${id}`, {
            headers: gistHeaders(token),
        })
        const json = await resp.json() as { updated_at?: string }
        return json.updated_at && isValidTimestamp(json.updated_at) ? json.updated_at : undefined
    } catch (_) {
        return
    }
}

export interface GistSendResult {
    id: string
    updatedAt: string
}

export async function sendGist(token: string, id: string | undefined, data: Sync): Promise<GistSendResult> {
    const description = 'File automatically generated by Bonjourr.'
    const files = { [GIST_FILENAME]: { content: stringify(data) } }

    if (isStorageDefault(data)) {
        throw new Error(GIST_ERROR.DEFAULT)
    }

    // Create
    if (!id) {
        const resp = await gistFetch('https://api.github.com/gists', {
            body: JSON.stringify({ files, description, public: false }),
            headers: gistHeaders(token),
            method: 'POST',
        })

        const api = await resp.json() as { id?: string; updated_at?: string }
        if (!api.id || !api.updated_at || !isValidTimestamp(api.updated_at)) {
            throw new Error(GIST_ERROR.JSON)
        }
        return {
            id: api.id,
            updatedAt: api.updated_at,
        }
    }

    if (isGistIdValid(id) === false) {
        throw new Error(GIST_ERROR.ID)
    }

    // Update — if the remote Gist was deleted (404), fall back to creating a new one.
    const resp = await gistFetch(`https://api.github.com/gists/${id}`, {
        body: JSON.stringify({ files, description }),
        headers: gistHeaders(token),
        method: 'PATCH',
    }, { 404: GIST_ERROR.NOGIST }).catch((err) => {
        if (err instanceof Error && err.message === GIST_ERROR.NOGIST) {
            return undefined
        }
        throw err
    })

    if (!resp) {
        const createResp = await gistFetch('https://api.github.com/gists', {
            body: JSON.stringify({ files, description, public: false }),
            headers: gistHeaders(token),
            method: 'POST',
        })

        const api = await createResp.json() as { id?: string; updated_at?: string }
        if (!api.id || !api.updated_at || !isValidTimestamp(api.updated_at)) {
            throw new Error(GIST_ERROR.JSON)
        }
        return {
            id: api.id,
            updatedAt: api.updated_at,
        }
    }

    const json = await resp.json() as { updated_at?: string }
    if (!json.updated_at || !isValidTimestamp(json.updated_at)) {
        throw new Error(GIST_ERROR.JSON)
    }
    return {
        id,
        updatedAt: json.updated_at,
    }
}

export async function findGistId(token?: string): Promise<string | undefined> {
    if (!token) {
        throw new Error(GIST_ERROR.TOKEN)
    }

    for (let page = 1; page <= GIST_MAX_LIST_PAGES; page++) {
        const resp = await gistFetch(`https://api.github.com/gists?per_page=100&page=${page}`, {
            headers: gistHeaders(token),
        })
        const list = (await resp.json()) as GistItem[]
        const file = list.find((gist) => !gist.public && gist.files[GIST_FILENAME]?.size > 0)

        if (file) return file.id
        if (list.length < 100) return
    }
}

function isGistIdValid(id?: string): boolean {
    if (!id || id.length > 32) {
        return false
    }

    for (const char of id) {
        const code = char.charCodeAt(0)
        const isHex = (code >= 97 && code <= 102) || (code >= 48 && code <= 57)

        if (!isHex) {
            return false
        }
    }

    return true
}

function trustedGistRawUrl(value: string): string {
    let url: URL

    try {
        url = new URL(value)
    } catch (_) {
        throw new Error(GIST_ERROR.JSON)
    }

    if (url.protocol !== 'https:' || url.hostname !== 'gist.githubusercontent.com') {
        throw new Error(GIST_ERROR.JSON)
    }

    return url.href
}

function isValidTimestamp(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
        Number.isFinite(new Date(value).getTime())
}

function gistHeaders(token: string): HeadersInit {
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }
}

async function fetchGistWithTimeout(input: RequestInfo, init?: RequestInit): Promise<Response> {
    const ms = init?.body ? GIST_WRITE_TIMEOUT_MS : GIST_READ_TIMEOUT_MS
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ms)

    try {
        return await fetch(input, { cache: 'no-store', credentials: 'omit', ...init, signal: controller.signal })
    } finally {
        clearTimeout(timeout)
    }
}

async function gistFetch(
    input: RequestInfo,
    init?: RequestInit,
    statusOverrides?: Record<number, string>,
): Promise<Response> {
    let resp: Response
    let lastError: unknown

    for (let attempt = 0; attempt < GIST_MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            await new Promise((r) => setTimeout(r, GIST_RETRY_DELAY_MS * attempt))
        }

        try {
            resp = await fetchGistWithTimeout(input, init)
        } catch (err) {
            lastError = err
            continue
        }

        if (resp.status >= 500) {
            lastError = new Error(GIST_ERROR.OTHER)
            continue
        }

        if (statusOverrides && resp.status in statusOverrides) {
            throw new Error(statusOverrides[resp.status])
        }
        if (resp.status === 401) {
            throw new Error(GIST_ERROR.TOKEN)
        }
        if (!resp.ok) {
            throw new Error(GIST_ERROR.OTHER)
        }

        return resp
    }

    // 5xx 重试耗尽保留原错误；fetch 本身抛出的（TypeError: Failed to fetch、
    // AbortError 超时）都是连接层问题，统一归类为网络错误。
    if (lastError instanceof Error && lastError.message === GIST_ERROR.OTHER) {
        throw lastError
    }
    throw new SyncNetworkError(GIST_ERROR.NOCONN)
}

const GIST_MAX_RETRIES = 3
const GIST_MAX_LIST_PAGES = 10
const GIST_RETRY_DELAY_MS = 1500
const GIST_READ_TIMEOUT_MS = 10000
const GIST_WRITE_TIMEOUT_MS = 30000
const MAX_REMOTE_CONFIG_BYTES = 4_000_000
const GIST_FILENAME = 'bonjourr-export.json'

const GIST_ERROR = {
    ID: tradThis('Invalid Gist ID in settings.'),
    TOKEN: tradThis('Invalid token.'),
    NOGIST: tradThis('Bonjourr file not found in Gists.'),
    NOCONN: tradThis('Cannot connect to GitHub.'),
    JSON: tradThis('Invalid JSON response from GitHub.'),
    OTHER: tradThis('Unexpected GitHub Gist error.'),
    DEFAULT: tradThis('Tried to send default config.'),
}

import { getLang, tradThis } from '../../utils/translations.ts'
import { stableStringify } from '../../utils/stringify.ts'
import { isStorageDefault, storage } from '../../storage.ts'

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
}

export function setGistStatusNow(gistId?: string): void {
    const wrapper = document.getElementById('gist-sync-status-wrapper') as HTMLElement
    const base = document.getElementById('gist-sync-status-base') as HTMLSpanElement

    const dateString = new Date().toLocaleString(getLang(), {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    })

    document.querySelector('#gist-sync-status')?.remove()

    if (gistId) {
        const link = document.createElement('a')
        link.id = 'gist-sync-status'
        link.href = `https://gist.github.com/${gistId}`
        link.textContent = dateString
        wrapper?.appendChild(link)
    } else {
        const span = document.createElement('span')
        span.id = 'gist-sync-status'
        span.textContent = dateString
        wrapper?.appendChild(span)
    }

    base.textContent = tradThis('Last update')
}

// 节流：toggleSyncSettingsOption 在多处调用（settings 加载、改 token/url、切 syncType …），
// 每次都打一次 GitHub。短时间内反复点设置面板的人会暴打 API。
// 60s 内复用上次成功结果，不再 fetch。
const STATUS_FETCH_THROTTLE_MS = 60_000
let cachedStatus: { at: number; updatedAt: string; htmlUrl: string; key: string } | undefined

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
        renderStatus(wrapper, base, cachedStatus.updatedAt, cachedStatus.htmlUrl)
        return true
    }

    // autoSyncOnStartup 已经记过 gistLastFetchedAt + gistLastSyncedAt。
    // 用它们当 fallback 渲染：跨标签页打开 settings 也不需要再 fetch。
    const local = await storage.local.get(['gistLastFetchedAt', 'gistLastSyncedAt'])
    const lastFetchedAt = local.gistLastFetchedAt ? new Date(local.gistLastFetchedAt).getTime() : 0
    const persistedHit = lastFetchedAt && now - lastFetchedAt < STATUS_FETCH_THROTTLE_MS

    if (persistedHit && local.gistLastSyncedAt) {
        renderStatus(wrapper, base, local.gistLastSyncedAt, `https://gist.github.com/${id}`)
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
    cachedStatus = { at: now, updatedAt: json.updated_at, htmlUrl: json.html_url, key: cacheKey }
    storage.local.set({ gistLastFetchedAt: new Date(now).toISOString() })
    renderStatus(wrapper, base, json.updated_at, json.html_url)
    return true
}

function renderStatus(wrapper: HTMLElement, base: HTMLSpanElement, isoDate: string, htmlUrl: string): void {
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
    link.href = htmlUrl
    link.textContent = dateString

    wrapper?.appendChild(link)
    base.textContent = tradThis('Last update')
}

export interface GistRetrieveResult {
    sync: Sync
    updatedAt: string
}

export async function retrieveGist(token: string, id?: string): Promise<GistRetrieveResult> {
    type GistGet = {
        files: Record<string, { content: string } | undefined>
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
    const content = gist?.files?.[GIST_FILENAME]?.content

    if (!content) {
        throw new Error(GIST_ERROR.NOGIST)
    }

    try {
        return {
            sync: JSON.parse(content),
            updatedAt: gist.updated_at ?? new Date().toISOString(),
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
        return json.updated_at
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
    const files = { [GIST_FILENAME]: { content: stableStringify(data, 2) } }

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

        const api = await resp.json() as { id: string; updated_at?: string }
        return {
            id: api.id,
            updatedAt: api.updated_at ?? new Date().toISOString(),
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

        const api = await createResp.json() as { id: string; updated_at?: string }
        return {
            id: api.id,
            updatedAt: api.updated_at ?? new Date().toISOString(),
        }
    }

    const json = await resp.json() as { updated_at?: string }
    return {
        id,
        updatedAt: json.updated_at ?? new Date().toISOString(),
    }
}

export async function findGistId(token?: string): Promise<string | undefined> {
    if (!token) {
        throw new Error(GIST_ERROR.TOKEN)
    }

    const resp = await gistFetch('https://api.github.com/gists?per_page=100', {
        headers: gistHeaders(token),
    })

    const list = (await resp.json()) as GistItem[]
    const file = list.filter((gist) => !gist.public && gist.files[GIST_FILENAME]?.size > 0)[0]

    return file?.id
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
        return await fetch(input, { ...init, signal: controller.signal })
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

    throw lastError instanceof Error ? lastError : new Error(GIST_ERROR.NOCONN)
}

const GIST_MAX_RETRIES = 3
const GIST_RETRY_DELAY_MS = 1500
const GIST_READ_TIMEOUT_MS = 10000
const GIST_WRITE_TIMEOUT_MS = 30000
const GIST_FILENAME = 'bonjourr-export.json'

const GIST_ERROR = {
    ID: tradThis('Invalid Gist ID in settings.'),
    TOKEN: tradThis('Invalid token.'),
    NOGIST: tradThis('Bonjourr file not found in Gists.'),
    NOCONN: tradThis('Cannot connect to GitHub.'),
    JSON: tradThis('Invalid JSON response from GitHub.'),
    OTHER: tradThis('Unexpected GitHub Gist error.'),
    DEFAULT: tradThis('Tried to send default config.'),
    STALE: tradThis('Remote Gist is newer than local. Please download first.'),
}

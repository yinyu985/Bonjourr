import { tradThis } from '../../utils/translations.ts'

import type { Backgrounds } from '../../../types/sync.ts'
import type { Background } from '../../../types/shared.ts'

const UNSPLASH_ORIGIN = 'https://unsplash.com'
const UNSPLASH_API_ORIGIN = 'https://api.unsplash.com'
const UTM_SOURCE = 'bonjourr-fork'
const UTM_MEDIUM = 'referral'

export function toggleCredits(backgrounds: Backgrounds): void {
    const container = document.getElementById('background-credit')
    container?.classList.toggle('shown', backgrounds.type === 'images')

    if (backgrounds.type !== 'images') {
        const attribution = document.getElementById('background-attribution')
        attribution?.replaceChildren()
        if (attribution) attribution.hidden = true
        updateDownloadTarget()
    }
}

export function updateCredits(image?: Background): void {
    updateDownloadTarget(image)
    updateMainAttribution(image)

    const el = document.getElementById('credit-text')

    if (!el) {
        return
    }

    el.textContent = ''

    if (!image?.page || !image?.username) return

    const author = image.name || image.username
    const city = image.city || ''
    const country = image.country || ''
    const comma = city && country ? ', ' : ''
    const location = `${city}${comma}${country}`
    const text = [author, location].filter(Boolean).join(' · ')

    const link = document.createElement('a')
    link.textContent = text

    const page = safeCreditUrl(image)
    if (!page) return
    link.href = page

    link.target = '_blank'
    link.rel = 'noopener noreferrer'

    el.appendChild(link)
}

function updateDownloadTarget(image?: Background): void {
    const anchor = document.querySelector<HTMLAnchorElement>('#download-background')
    const button = document.querySelector<HTMLButtonElement>('#b_interface-background-download')
    const downloadLocation = safeUnsplashDownloadLocation(image?.download)

    if (anchor) {
        if (downloadLocation) {
            anchor.dataset.downloadLocation = downloadLocation
        } else {
            delete anchor.dataset.downloadLocation
        }
    }
    button?.toggleAttribute('disabled', !downloadLocation)
}

function safeCreditUrl(image: Background): string | undefined {
    if (isUnsplashImage(image)) {
        return unsplashProfileUrl(image.username)
    }

    return safeHttpsUrl(image.page)
}

function safeHttpsUrl(value?: string): string | undefined {
    try {
        const url = new URL(value ?? '')
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
    } catch (_) {
        return
    }
}

export function safeUnsplashDownloadLocation(value?: string): string | undefined {
    const url = safeHttpsUrl(value)
    if (!url) return

    const parsed = new URL(url)
    const isDownloadLocation = /^\/photos\/[A-Za-z0-9_-]+\/download$/.test(parsed.pathname)

    return parsed.origin === UNSPLASH_API_ORIGIN && isDownloadLocation && !parsed.hash ? parsed.href : undefined
}

function updateMainAttribution(image?: Background): void {
    const container = document.getElementById('background-attribution')
    if (!container) return

    container.replaceChildren()

    if (!image || !isUnsplashImage(image)) {
        container.hidden = true
        return
    }

    const photographerUrl = unsplashProfileUrl(image.username)
    if (!photographerUrl) {
        container.hidden = true
        return
    }

    const author = image.name?.trim() || image.username?.trim()
    if (!author) {
        container.hidden = true
        return
    }

    const [beforeAuthor = '', afterAuthor = ''] = tradThis('Photo by <name>').split('<name>')
    container.append(
        document.createTextNode(beforeAuthor),
        externalLink(author, photographerUrl),
        document.createTextNode(afterAuthor),
        document.createTextNode(' · '),
        externalLink('Unsplash', unsplashHomeUrl()),
    )
    container.hidden = false
}

function isUnsplashImage(image: Background): boolean {
    return isUnsplashPage(image.page) || safeUnsplashDownloadLocation(image.download) !== undefined
}

function isUnsplashPage(value?: string): boolean {
    const url = safeHttpsUrl(value)
    return url !== undefined && new URL(url).origin === UNSPLASH_ORIGIN
}

function unsplashProfileUrl(username?: string): string | undefined {
    const safeUsername = username?.trim()
    if (!safeUsername) return

    const url = new URL(`/@${encodeURIComponent(safeUsername)}`, UNSPLASH_ORIGIN)
    addAttributionParams(url)
    return url.href
}

function unsplashHomeUrl(): string {
    const url = new URL('/', UNSPLASH_ORIGIN)
    addAttributionParams(url)
    return url.href
}

function addAttributionParams(url: URL): void {
    url.searchParams.set('utm_source', UTM_SOURCE)
    url.searchParams.set('utm_medium', UTM_MEDIUM)
}

function externalLink(text: string, href: string): HTMLAnchorElement {
    const link = document.createElement('a')
    link.textContent = text
    link.href = href
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    return link
}

import { BROWSER } from '../defaults.ts'
import { minutator, suntime } from '../shared/time.ts'
import { getReadableTextColor, hexToRGB, stringMaxSize } from '../shared/generic.ts'
import { eventDebounce } from '../utils/debounce.ts'
import { tradThis } from '../utils/translations.ts'
import { storage } from '../storage.ts'

let systemThemeQuery: MediaQueryList | undefined
const updateSystemTheme = (event: MediaQueryListEvent): void => {
    document.documentElement.dataset.theme = event.matches ? 'dark' : 'light'
}

export function favicon(val?: string, isEvent?: true): void {
    function createFavicon(emoji?: string): void {
        const escaped = emoji?.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
        const svgtext = `<text y=".9em" font-size="85">${escaped}</text>`
        const svgtag = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${svgtext}</svg>`
        const svgdata = `data:image/svg+xml,${encodeURIComponent(svgtag)}`
        const domfavicon = document.querySelector<HTMLLinkElement>('#favicon')

        if (!domfavicon) return
        if (!('defaultHref' in domfavicon.dataset)) {
            domfavicon.dataset.defaultHref = domfavicon.getAttribute('href') ?? ''
        }

        if (emoji) domfavicon.href = svgdata
        else if (domfavicon.dataset.defaultHref) domfavicon.href = domfavicon.dataset.defaultHref
        else domfavicon.removeAttribute('href')
    }

    if (BROWSER === 'edge') {
        return
    }

    if (isEvent) {
        const isEmojiOrShape = val?.match(/[\p{Emoji}\u25A0-\u25FF]/gu) && !val?.match(/[0-9a-z]/g)
        eventDebounce({ favicon: isEmojiOrShape ? val : '' })
        document.getElementById('head-favicon')?.remove()
    }

    createFavicon(val)
}

export function tabTitle(val?: string, isEvent?: true): void {
    val ??= ''

    document.title = stringMaxSize(val, 80) || tradThis('New tab')

    if (isEvent) {
        eventDebounce({ tabtitle: stringMaxSize(val, 80) })
    }
}

export function darkmode(value: 'auto' | 'system' | 'enable' | 'disable', isEvent?: boolean): void {
    const settings = document.querySelector<HTMLElement>('aside')
    let theme = 'light'

    systemThemeQuery?.removeEventListener('change', updateSystemTheme)
    systemThemeQuery = undefined

    switch (value) {
        case 'disable':
            theme = 'light'
            break

        case 'enable':
            theme = 'dark'
            break

        case 'system':
            systemThemeQuery = globalThis.matchMedia('(prefers-color-scheme: dark)')
            theme = systemThemeQuery.matches ? 'dark' : 'light'
            systemThemeQuery.addEventListener('change', updateSystemTheme)
            break

        default: {
            const now = minutator(new Date())
            const { sunrise, sunset } = suntime()
            theme = now <= sunrise || now > sunset ? 'dark' : 'light'
        }
    }

    document.documentElement.dataset.theme = theme

    if (isEvent) {
        void storage.sync.set({ dark: value }).catch((err) => {
            console.warn('Failed to save theme preference', err)
        })
        settings?.classList.add('change-theme')

        setTimeout(() => {
            settings?.classList.remove('change-theme')
        }, 333)
    }
}

export function settingsBackgroundColor(color?: string): void {
    if (!color?.startsWith('#')) {
        return
    }

    const sourceRgb = hexToRGB(color)
    const panelRgb = mixWithWhite(sourceRgb, 0.15)
    const sectionRgb = mixWithWhite(sourceRgb, 0.28)
    const inputRgb = mixWithWhite(sourceRgb, 0.22)
    const outsideRgb = mixWithWhite(sourceRgb, 0.18)
    const focusedRgb = mixWithWhite(sourceRgb, 0.25)
    const borderRgb = mixWithWhite(sourceRgb, 0.35)
    const isDarkPanel = getReadableTextColor(panelRgb) === 'white'
    const textHex = isDarkPanel ? '#f5f7fa' : '#1e232b'
    const lightTextHex = isDarkPanel ? '#c4c9d2' : '#5d6672'
    const placeholderHex = isDarkPanel ? '#9ca4b0' : '#6d7682'
    const linkTextHex = isDarkPanel ? '#9ed0ff' : '#1f5fba'
    const dialogAlpha = isDarkPanel ? 'd9' : 'cc'
    const dialogInputAlpha = isDarkPanel ? 0.22 : 0.12
    const rootStyle = document.documentElement.style

    rootStyle.setProperty('--color-settings', cssRgb(panelRgb))
    rootStyle.setProperty('--color-settings-section', cssRgb(sectionRgb))
    rootStyle.setProperty('--color-settings-section-border', cssRgb(borderRgb))
    rootStyle.setProperty(
        '--color-settings-section-highlight',
        isDarkPanel ? '#ffffff14' : '#ffffffb3',
    )
    rootStyle.setProperty('--color-text', textHex)
    rootStyle.setProperty('--color-light-text', lightTextHex)
    rootStyle.setProperty('--color-placeholder', placeholderHex)
    rootStyle.setProperty('--color-blue', linkTextHex)
    rootStyle.setProperty('--color-param', `${panelRgb.r}, ${panelRgb.g}, ${panelRgb.b}`)
    rootStyle.setProperty('--color-areas', cssRgb(sectionRgb))
    rootStyle.setProperty('--color-input', cssRgb(inputRgb))
    rootStyle.setProperty('--color-input-outside', cssRgb(outsideRgb))
    rootStyle.setProperty('--color-focused', cssRgb(focusedRgb))
    rootStyle.setProperty('--color-border', cssRgb(borderRgb))
    rootStyle.setProperty('--color-areas-text', textHex)
    rootStyle.setProperty('--color-dialog', `${color}${dialogAlpha}`)
    rootStyle.setProperty('--color-dialog-border', isDarkPanel ? '#ffffff30' : '#1a1f2b22')
    rootStyle.setProperty('--color-dialog-highlight', isDarkPanel ? '#ffffff1a' : '#ffffff66')
    rootStyle.setProperty('--color-dialog-input-text', textHex)
    rootStyle.setProperty(
        '--color-dialog-input-bg',
        `rgba(${sourceRgb.r}, ${sourceRgb.g}, ${sourceRgb.b}, ${dialogInputAlpha})`,
    )
}

function mixWithWhite(
    rgb: { r: number; g: number; b: number },
    whiteRatio: number,
): { r: number; g: number; b: number } {
    return {
        r: Math.round(rgb.r * (1 - whiteRatio) + 255 * whiteRatio),
        g: Math.round(rgb.g * (1 - whiteRatio) + 255 * whiteRatio),
        b: Math.round(rgb.b * (1 - whiteRatio) + 255 * whiteRatio),
    }
}

function cssRgb(rgb: { r: number; g: number; b: number }): string {
    return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`
}

export function textShadow(init?: number, event?: number): void {
    const val = init ?? event
    document.documentElement.style.setProperty('--text-shadow-alpha', (val ?? 0.2)?.toString())

    if (typeof event === 'number') {
        eventDebounce({ textShadow: val })
    }
}

// Unfocus address bar on chromium
// https://stackoverflow.com/q/64868024
// if (window.location.search !== '?r=1') {
// 	window.location.assign('index.html?r=1')
// }

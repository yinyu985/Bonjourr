import { langList } from './langs.ts'
import { CURRENT_VERSION } from './version.ts'
export { CURRENT_VERSION }

import type { Navigator } from '../types/shared.ts'
import type { Local } from '../types/local.ts'
import type { Sync } from '../types/sync.ts'

const navigator = globalThis.navigator as Navigator
const iosUA = 'iPad Simulator|iPhone Simulator|iPod Simulator|iPad|iPhone|iPod'.split('|')
const mobileUA = 'Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini'.split('|')

export const ENVIRONNEMENT: 'PROD' | 'DEV' | 'TEST' = globalThis.ENV ?? 'TEST'

export const SYSTEM_OS = iosUA.includes(navigator.platform) ||
        (navigator.userAgent?.includes('Mac') && 'ontouchend' in document)
    ? 'ios'
    : navigator.appVersion?.includes('Macintosh')
    ? 'mac'
    : navigator.appVersion?.includes('Windows')
    ? 'windows'
    : navigator.userAgent?.toLowerCase()?.includes('android')
    ? 'android'
    : 'unknown'

export const PLATFORM = globalThis.location?.protocol === 'moz-extension:'
    ? 'firefox'
    : globalThis.location?.protocol === 'chrome-extension:'
    ? 'chrome'
    : globalThis.location?.protocol === 'safari-web-extension:'
    ? 'safari'
    : 'online'

export const BROWSER = navigator?.userAgentData?.brands.some((b) => b.brand === 'Microsoft Edge')
    ? 'edge'
    : navigator?.userAgentData?.brands.some((b) => b.brand === 'Opera')
    ? 'opera'
    : navigator?.userAgentData?.brands.some((b) => b.brand === 'Chromium')
    ? 'chrome'
    : navigator.userAgent?.toLowerCase()?.indexOf('firefox') > -1
    ? 'firefox'
    : navigator.userAgent?.toLowerCase()?.indexOf('safari') > -1
    ? 'safari'
    : 'other'

export const EXTENSION: typeof chrome | typeof browser | undefined = PLATFORM === 'online'
    ? undefined
    : PLATFORM === 'firefox'
    ? browser
    : chrome

export const IS_MOBILE = navigator.userAgentData
    ? navigator.userAgentData.mobile
    : mobileUA.some((ua) => navigator.userAgent.includes(ua))

const DEFAULT_LANG = (() => {
    for (const code of Object.keys(langList)) {
        if (navigator.language.replace('-', '_').includes(code)) {
            return code as keyof typeof langList
        }
    }
    return 'en'
})()

export const SYNC_DEFAULT: Sync = {
    lang: DEFAULT_LANG,
    dark: 'system',
    favicon: '',
    tabtitle: '',
    time: true,
    showall: true,
    dateformat: 'auto',
    textShadow: 0,
    css: '',
    hide: {},
    clock: {
        size: 1.3,
        ampm: false,
        seconds: true,
        timezone: 'auto',
    },
    font: {
        family: 'Nunito',
        size: '7',
        system: false,
        weight: '400',
    },
    backgrounds: {
        type: 'color',
        blur: 0,
        bright: 0.78,
        frequency: 'pause',
        color: '#222222',
        urls: '',
        images: '',
        queries: {},
        texture: {
            type: 'topographic',
            opacity: 0.4,
            size: 500,
            color: '#ffffff',
        },
    },
    notes: {
        active: '',
        records: [],
    },
    links: {
        enabled: true,
        foldersOn: false,
        selectedFolder: 'default',
        rows: 16,
        iconRadius: 0,
        style: 'text',
        newTab: true,
        titles: false,
        backgrounds: true,
        folders: [{
            id: 'default',
            title: 'default',
            items: [],
        }],
        favorites: [],
    },
}

export const LOCAL_DEFAULT: Local = {
    syncType: 'off',
    gistToken: '',
    translations: undefined,
    backgroundUrls: {},
    backgroundFiles: {},
    backgroundCollections: {},
    backgroundCompressFiles: true,
    backgroundLastChange: '',
}

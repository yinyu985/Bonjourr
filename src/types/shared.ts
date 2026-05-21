import type { BackgroundFile, Local } from './local.ts'
import type { langList } from '../scripts/langs.ts'
import type { Sync } from './sync.ts'

export type Langs = keyof typeof langList
export type Link = LinkSubfolder | LinkElem
export type LinkNode = LinkSubfolder | LinkElem
export type Background = BackgroundImage
export type Frequency = 'tabs' | 'hour' | 'day' | 'period' | 'pause'
export type LinkIconType = 'auto' | 'library' | 'file' | 'url'

export interface BackgroundImage {
    format: 'image'
    mimetype?: string
    urls: {
        full: string
        small: string
    }
    page?: string
    username?: string
    color?: string
    name?: string
    city?: string
    country?: string
    download?: string
    file?: BackgroundFile
}

export interface LinkElem {
    id: string
    title: string
    url: string
    icon?: LinkIcon
}

export interface LinkIcon {
    type: LinkIconType
    value?: string
}

export interface LinkSubfolder {
    id: string
    title: string
    items: LinkElem[]
}

// Globals

declare global {
    var pageReady: boolean
    var startupBookmarks: browser.bookmarks.BookmarkTreeNode[] | undefined
    var startupStorage: {
        sync?: Sync
        local?: Local
    }
    var ENV: 'PROD' | 'DEV' | 'TEST'
}

// https://github.com/lukewarlow/user-agent-data-types
// WICG Spec: https://wicg.github.io/ua-client-hints

export interface Navigator extends globalThis.Navigator {
    readonly userAgentData?: NavigatorUAData
}

// https://wicg.github.io/ua-client-hints/#dictdef-navigatoruabrandversion
interface NavigatorUABrandVersion {
    readonly brand: string
    readonly version: string
}

// https://wicg.github.io/ua-client-hints/#dictdef-uadatavalues
interface UADataValues {
    readonly brands?: NavigatorUABrandVersion[]
    readonly mobile?: boolean
    readonly platform?: string
    readonly architecture?: string
    readonly bitness?: string
    readonly formFactor?: string[]
    readonly model?: string
    readonly platformVersion?: string
    /** @deprecated in favour of fullVersionList */
    readonly uaFullVersion?: string
    readonly fullVersionList?: NavigatorUABrandVersion[]
    readonly wow64?: boolean
}

// https://wicg.github.io/ua-client-hints/#dictdef-ualowentropyjson
interface UALowEntropyJSON {
    readonly brands: NavigatorUABrandVersion[]
    readonly mobile: boolean
    readonly platform: string
}

// https://wicg.github.io/ua-client-hints/#navigatoruadata
interface NavigatorUAData extends UALowEntropyJSON {
    getHighEntropyValues(hints: string[]): Promise<UADataValues>
    toJSON(): UALowEntropyJSON
}

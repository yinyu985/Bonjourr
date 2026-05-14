import type { Background } from './shared.ts'
import type { Sync } from './sync.ts'

export type BackgroundUrlState = 'NONE' | 'LOADING' | 'OK' | 'NOT_URL' | 'CANT_REACH' | 'NOT_MEDIA'
export type SyncType = 'browser' | 'gist' | 'url' | 'off'

export interface Local {
    fonts?: FontListItem[]
    fontface?: string
    translations?: Translations
    operaExplained?: true

    // Sync
    gistId?: string
    gistToken?: string
    distantUrl?: string
    syncType?: SyncType

    // Backgrounds
    backgroundCollections: Record<string, Background[]>
    backgroundUrls: Record<string, BackgroundUrl>
    backgroundFiles: Record<string, BackgroundFile>
    backgroundLastChange?: string
    backgroundCompressFiles?: boolean

    // Online
    syncStorage?: Sync

    // Links
    linkIconResolutions?: Record<string, string>
    [key: `x-icon-${string}`]: string
}

export interface BackgroundUrl {
    lastUsed: string
    format: 'image' | 'video'
    state: BackgroundUrlState
    duration?: number
}

/**
 * Bad planning in version 21: interface structure is image only.
 *
 * Video options "zoom, fade, playbackRate" have been added separately
 * "position" remains image only...
 */
export interface BackgroundFile {
    format: 'image' | 'video'
    lastUsed: string
    selected?: boolean
    video?: {
        playbackRate: number
        fade: number
        zoom: number
    }
    position?: {
        size: string
        x: string
        y: string
    }
}

export interface FontListItem {
    family: string
    weights: string[]
    variable: boolean
}

export type Translations = {
    lang: string
    [key: string]: string
}

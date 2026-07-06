import type { Background } from './shared.ts'
import type { Sync } from './sync.ts'

export type BackgroundUrlState = 'NONE' | 'LOADING' | 'OK' | 'NOT_URL' | 'CANT_REACH' | 'NOT_MEDIA'
export type RemoteProviderKind = 'gist' | 'dropbox' | 'google-drive'
export type SyncType = RemoteProviderKind | 'off'

export interface Local {
    fonts?: FontListItem[]
    fontface?: string
    translations?: Translations
    operaExplained?: true

    // Sync
    gistToken?: string
    remoteResourceId?: string
    remoteLastSyncedAt?: string
    remoteLastFetchedAt?: string
    localConfigUpdatedAt?: string
    lastSyncedPayload?: string
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
    state: BackgroundUrlState
}

export interface BackgroundFile {
    lastUsed: string
    selected?: boolean
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

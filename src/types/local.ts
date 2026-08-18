import type { Background } from './shared.ts'
import type { Sync } from './sync.ts'

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
    unsplashAccessKey?: string
    backgroundCollections: Record<string, Background[]>
    backgroundLastChange?: string
    backgroundLastTrackedPhoto?: string

    // Online
    syncStorage?: Sync
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

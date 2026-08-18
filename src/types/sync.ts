import type { BackgroundImage, Frequency, LinkElem, LinkNode } from './shared.ts'

export interface Sync {
    time: boolean
    links: LinksState
    textShadow: number
    css: string
    lang: string
    favicon: string
    tabtitle: string
    hide?: Hide
    dark: 'auto' | 'system' | 'enable' | 'disable'
    dateformat: 'auto' | 'eu' | 'us' | 'cn'
    backgrounds: Backgrounds
    clock: Clock
    font: Font
    notes?: Notes
    [key: string]: unknown
}

export interface LinksState {
    enabled: boolean
    foldersOn: boolean
    selectedFolder: string
    rows: number
    iconRadius: number
    style: 'inline' | 'text'
    newTab: boolean
    titles: boolean
    backgrounds: boolean
}

export interface BookmarkLinksState extends LinksState {
    folders: LinkFolder[]
    favorites: LinkElem[]
    /** Snapshot-only order of top-level bookmark and folder IDs. */
    toolbarOrder?: string[]
}

export interface SyncSnapshot extends Sync {
    links: BookmarkLinksState
}

export interface LinkFolder {
    id: string
    title: string
    items: LinkNode[]
}

export interface Hide {
    clock?: boolean
    date?: boolean
}

export interface Backgrounds {
    type: 'images' | 'color'
    frequency: Frequency
    bright: number
    blur: number
    color: string
    images: string
    pausedImage?: BackgroundImage
    query: string
    texture: {
        type:
            | 'none'
            | 'grain'
            | 'verticalDots'
            | 'diagonalDots'
            | 'topographic'
            | 'checkerboard'
            | 'isometric'
            | 'grid'
            | 'verticalLines'
            | 'horizontalLines'
            | 'diagonalStripes'
            | 'verticalStripes'
            | 'horizontalStripes'
            | 'diagonalLines'
            | 'aztec'
            | 'circuitBoard'
            | 'ticTacToe'
            | 'endlessClouds'
            | 'vectorGrain'
            | 'waves'
            | 'honeycomb'
        size?: number
        opacity?: number
        color?: string
    }
}

export interface Clock {
    ampm: boolean
    seconds: boolean
    timezone: string
    size: number
}

export interface Font {
    family: string
    size: string
    weight: string
    system?: boolean
}

export interface Notes {
    active: string
    records: NoteRecord[]
}

export interface NoteRecord {
    id: string
    title: string
    content: string
    updatedAt: string
}

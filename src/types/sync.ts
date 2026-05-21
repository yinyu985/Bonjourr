import type { BackgroundImage, Frequency, LinkElem, LinkNode } from './shared.ts'

export interface Sync {
    showall: boolean
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
    folders: LinkFolder[]
    favorites: LinkElem[]
}

export interface LinkFolder {
    id: string
    title: string
    source: LinkFolderSource
    items: LinkNode[]
}

export type LinkFolderSource = 'local' | 'bookmarks'

export interface Hide {
    clock?: boolean
    date?: boolean
}

export interface Backgrounds {
    type: 'files' | 'urls' | 'images' | 'color'
    frequency: Frequency
    bright: number
    blur: number
    color: string
    urls: string
    images: string
    pausedUrl?: string
    pausedImage?: BackgroundImage
    queries: Record<string, string>
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

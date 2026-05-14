import type { BackgroundImage, BackgroundVideo, Frequency, LinkElem, LinkNode } from './shared.ts'

export interface Sync {
    showall: boolean
    time: boolean
    links: LinksState
    textShadow: number
    review: number
    announcements: 'major' | 'off'
    css: string
    lang: string
    favicon: string
    tabtitle: string
    hide?: Hide
    dark: 'auto' | 'system' | 'enable' | 'disable'
    dateformat: 'auto' | 'eu' | 'us' | 'cn'
    backgrounds: Backgrounds
    clock: Clock
    analogstyle?: AnalogStyle
    font: Font
    notes?: Notes
    about: {
        browser: string
        version: string
    }
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
    type: 'files' | 'urls' | 'images' | 'videos' | 'color'
    frequency: Frequency
    fadein: number
    bright: number
    blur: number
    color: string
    urls: string
    images: string
    videos: string
    mute: boolean
    pausedUrl?: string
    pausedImage?: BackgroundImage
    pausedVideo?: BackgroundVideo
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
    analog: boolean
    seconds: boolean
    timezone: string
    size: number
    face?: 'none' | 'number' | 'roman' | 'marks'
    style?: 'round' | 'square' | 'transparent'
}

export interface AnalogStyle {
    border: string
    background: string
    shape: 'round' | 'square' | 'rectangle'
    face: 'none' | 'number' | 'roman' | 'marks' | 'swiss' | 'braun'
    hands: 'modern' | 'swiss' | 'classic' | 'braun' | 'apple'
}

export interface Font {
    id?: string
    family: string
    size: string
    weight: string
    weightlist: string[]
    system?: boolean
    url?: string
    availWeights?: string[]
}

export interface Notes {
    active: string
    records: NoteRecord[]
}

export interface NoteRecord {
    id: string
    title: string
    content: string
    updatedAt: number
}

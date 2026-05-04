import type { BackgroundImage, BackgroundVideo, Frequency, Link } from './shared.ts'

export interface Sync {
    showall: boolean
    quicklinks: boolean
    time: boolean
    linksrow: number
    linkiconradius: number
    linkstyle: 'inline' | 'text'
    linknewtab: boolean
    linktitles: boolean
    linkbackgrounds: boolean
    linkgroups: LinkGroups
    textShadow: number
    review: number
    announcements: 'major' | 'off'
    supporters: Supporters
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
    about: {
        browser: string
        version: string
    }
    [key: string]: Link | unknown
}

export interface LinkGroups {
    on: boolean
    selected: string
    groups: string[]
    pinned: string[]
    synced: string[]
    hidden: Record<string, string[]>
}

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

export interface Supporters {
    enabled: boolean
    closedMonth?: number
}

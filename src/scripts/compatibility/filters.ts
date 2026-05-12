import { countryCodeToLanguageCode } from '../utils/translations.ts'
import { SYNC_DEFAULT } from '../defaults.ts'

import type { OldSync } from '../../types/shared.ts'
import type { Sync } from '../../types/sync.ts'

type Import = Record<string, unknown> & {
    linktabs?: OldSync['linktabs']
    backgrounds?: Sync['backgrounds']
    font?: Partial<Sync['font']> & { availWeights?: string[]; url?: string }
    lang?: string
    clock?: Partial<Sync['clock']> & {
        style?: 'round' | 'square' | 'transparent'
        face?: NonNullable<Sync['analogstyle']>['face']
    }
    analogstyle?: Partial<Sync['analogstyle']>
    hide?: Sync['hide'] | unknown[]
}

export function fixNullBrightness(data: Import): Import {
    if (data.backgrounds?.bright === null) {
        data.backgrounds.bright = SYNC_DEFAULT.backgrounds.bright
    }

    return data
}

export function hideArrayToObject(data: Import): Import {
    const newhide: Sync['hide'] = {}

    if (Array.isArray(data.hide)) {
        const hide = data.hide as unknown[][]
        if (hide[0]?.[0]) {
            newhide.clock = true
        }
        if (hide[0]?.[1]) {
            newhide.date = true
        }
        data.hide = newhide
        data.time = !(data.hide.clock && data.hide.date)
    }

    return data
}

export function newFontSystem(data: Import): Import {
    if (data.font) {
        data.font.weightlist = data.font?.availWeights ?? []
        data.font.url = undefined
        data.font.availWeights = undefined

        // Always assume it is NOT a system font, unless specified
        if (data.font.system === undefined) {
            data.font.system = false
        }
    }

    return data
}

export function newReviewData(data: Import): Import {
    const reviewPopup = (data as { reviewPopup?: number | string }).reviewPopup

    if (reviewPopup) {
        data.review = reviewPopup === 'removed' ? -1 : +reviewPopup
    }

    return data
}

export function toIsoLanguageCode(data: Import): Import {
    data.lang = countryCodeToLanguageCode(data.lang ?? 'en')
    return data
}

export function clockDateFormat(data: Import): Import {
    const old = data as Partial<OldSync>

    if (old.usdate) {
        data.dateformat = 'us'
    } else {
        data.dateformat = 'auto'
    }

    return data
}

export function manualTimezonesToIntl(data: Import): Import {
    const timezoneMatches: Record<string, string> = {
        '-10': '-10:00',
        '-9': '-09:00',
        '-8': '-08:00',
        '-7': '-07:00',
        '-6': '-06:00',
        '-5': '-05:00',
        '-4': '-04:00',
        '-3': '-03:00',
        '+0': '+00:00',
        '+1': '+01:00',
        '+2': '+02:00',
        '+3': '+03:00',
        '+5:30': '+05:30',
        '+7': '+07:00',
        '+8': '+08:00',
        '+9': '+09:00',
        '+10': '+10:00',
        '+12': '+12:00',
    }

    const oldTimezones = Object.keys(timezoneMatches)

    const timezone = data.clock?.timezone
    if (timezone && oldTimezones.includes(timezone)) {
        data.clock!.timezone = timezoneMatches[timezone]
    }

    return data
}

/** Version 21: migrate from generic fields to a single "backgrounds" object */
export function newBackgroundsField(data: Import): Import {
    const olddata = data as Partial<OldSync>
    const defaults = structuredClone(SYNC_DEFAULT)

    if (!data.backgrounds) {
        data.backgrounds = defaults.backgrounds
    }

    if (olddata.background_blur !== undefined) {
        data.backgrounds.blur = olddata.background_blur
    }
    if (olddata.background_bright !== undefined) {
        data.backgrounds.bright = olddata.background_bright
    }
    if (olddata.background_type !== undefined) {
        data.backgrounds.type = olddata.background_type === 'unsplash' ? 'images' : 'files'
    }
    if (olddata.unsplash) {
        data.backgrounds.frequency = olddata.unsplash?.every ?? 'hour'
    }
    if (olddata.unsplash?.collection) {
        data.backgrounds.images = 'unsplash-images-collections'
        data.backgrounds.queries = { 'unsplash-images-collections': olddata.unsplash.collection }
    }

    return data
}

export function analogClockOptions<Data extends Sync | Import>(data: Data): Data {
    if (data.clock?.style) {
        data.analogstyle = {
            background: '#fff2',
            border: '#ffff',
            face: data?.clock?.face || 'none',
            shape: 'round',
            hands: 'modern',
        }

        if (data.clock.style === 'round' || data.clock.style === 'square') {
            data.analogstyle.shape = data.clock.style
        }

        if (data.clock.style === 'transparent') {
            data.analogstyle.background = '#fff0'
            data.analogstyle.border = '#fff0'
        }
    }

    return data
}

export function removeLinkgroupDuplicates(current: Sync): Sync {
    return current
}

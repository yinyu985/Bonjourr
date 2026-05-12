import { getLang, tradThis } from '../utils/translations.ts'
import { displayInterface } from '../shared/display.ts'
import { refreshCustomSelects } from '../shared/custom-select.ts'
import { onSettingsLoad } from '../utils/onsettingsload.ts'
import { eventDebounce } from '../utils/debounce.ts'
import { SYSTEM_OS } from '../defaults.ts'
import { subsets } from '../langs.ts'
import { storage } from '../storage.ts'
import { clock } from './clock/index.ts'

import type { Font, Sync } from '../../types/sync.ts'

interface Fontsource {
    id: string
    family: string
    subsets: string[]
    weights: number[]
    variable: boolean
}

type CustomFontUpdate = {
    autocomplete?: true
    lang?: true
    size?: string
    family?: string
    weight?: string
}

const FONTS_API = 'https://api.fontsource.org/v1/fonts'
const FONTS_CDN = 'https://cdn.jsdelivr.net/fontsource/fonts'
let fontlistCache: Fontsource[] | undefined

export const systemfont = (() => {
    const fonts = {
        fallback: { placeholder: 'Arial', weights: ['500', '600', '800'] },
        windows: { placeholder: 'Segoe UI', weights: ['300', '400', '600', '700', '800'] },
        android: { placeholder: 'Roboto', weights: ['100', '300', '400', '500', '700', '900'] },
        linux: { placeholder: 'Fira Sans', weights: ['100', '200', '300', '400', '500', '600', '700', '800', '900'] },
        apple: {
            placeholder: 'SF Pro Display',
            weights: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
        },
    }

    if (SYSTEM_OS === 'windows') {
        return fonts.windows
    }
    if (SYSTEM_OS === 'android') {
        return fonts.android
    }
    if (SYSTEM_OS === 'mac') {
        return fonts.apple
    }
    if (SYSTEM_OS === 'ios') {
        return fonts.apple
    }

    return fonts.linux
})()

export function customFont(init?: Font, event?: CustomFontUpdate): void {
    if (event) {
        updateCustomFont(event)
        return
    }

    if (init) {
        try {
            const font = migrateToNewFormat(init)
            displayFont(font)
            displayInterface('fonts')

            onSettingsLoad(() => {
                initFontSettings(font)
            })
        } catch (_) {
            // ...
        }
    }
}

//
//	Updates
//

async function updateCustomFont({ family, weight, size, lang, autocomplete }: CustomFontUpdate): Promise<void> {
    if (autocomplete) {
        setAutocompleteSettings()
        return
    }

    const data = await storage.sync.get('font')

    if (family !== undefined) {
        data.font = await updateFontFamily(data, family)
    }

    if (weight) {
        data.font.weight = weight || '400'
        displayFont(data.font)
    }

    if (size) {
        data.font.size = size
        setFontSize(size)
    }

    if (lang) {
        handleLangSwitch(data.font)
        return
    }

    eventDebounce({ font: data.font })
}

async function updateFontFamily(data: Sync, family: string): Promise<Font> {
    const iWeight = document.getElementById('i_weight') as HTMLInputElement
    const familyType = family.length === 0 ? 'none' : systemFontChecker(family) ? 'system' : 'fontsource'

    let font: Font = {
        family: '',
        system: true,
        size: data.font.size,
        weight: SYSTEM_OS === 'windows' ? '400' : '300',
        weightlist: systemfont.weights,
    }

    switch (familyType) {
        case 'fontsource': {
            const newfont = await getNewFont(font, family)

            if (newfont && navigator.onLine) {
                font = { ...font, ...newfont }
                displayFont(font)
                await waitForFontLoad(family)
                clock(undefined, {})
            }

            if (font.family === '') {
                return data.font
            }
            break
        }

        case 'system': {
            font.family = family
            displayFont(font)
            break
        }

        default: {
            displayFont(font)
        }
    }

    clock(undefined, {})
    setWeightSettings(font.weightlist)
    iWeight.value = font.weight

    return font
}

async function handleLangSwitch(font: Font): Promise<void> {
    const noCustomOrSystemFont = !font.family || font?.system

    if (noCustomOrSystemFont) {
        return
    }

    const newfont = await getNewFont(font, font.family)

    // remove font if not available with subset
    if (newfont === undefined) {
        updateCustomFont({ family: '' })
        return
    }

    font.family = newfont.family
    font.weight = newfont.weight
    font.weightlist = newfont.weightlist

    displayFont(font)
    setAutocompleteSettings(true)
}

async function getNewFont(font: Font, newfamily: string): Promise<Font | undefined> {
    const fontlist = await getFontList()
    let newfont: Fontsource | undefined

    for (const item of fontlist as Fontsource[]) {
        const hasCorrectSubset = item.subsets.includes(getRequiredSubset())
        const isFamily = item.family.toLowerCase() === newfamily.toLowerCase()

        if (hasCorrectSubset && isFamily) {
            newfont = item
        }
    }

    if (newfont) {
        font.weight = '400'
        font.system = false
        font.family = newfont.family
        font.id = newfont.id
        font.weightlist = newfont.weights.map((w) => w.toString())
        return font
    }

    // this undefined return is important
    // we need to know when no font is found
    return
}

function displayFont({ family, id, size, weight, system }: Font): void {
    // Weight: default bonjourr lowers font weight on clock (because we like it)
    const clockWeight = Number.parseInt(weight) > 100
        ? systemfont.weights[systemfont.weights.indexOf(weight) - 1]
        : weight
    const subset = getRequiredSubset()
    const fontId = id ?? family.toLocaleLowerCase().replaceAll(' ', '-')
    const fontfacedom = document.getElementById('fontface')

    if (!system) {
        let fontface = `
			@font-face {font-family: "${family}";
				font-display: swap;
				src: url(${FONTS_CDN}/${fontId}@latest/latin-${weight}-normal.woff2) format('woff2');
			}
		`

        if (subset !== 'latin') {
            fontface += fontface.replace('latin', subset)
        }

        if (fontfacedom) {
            fontfacedom.textContent += fontface
        }
    }

    document.documentElement.style.setProperty('--font-family', family ? `"${family}"` : null)
    document.documentElement.style.setProperty('--font-weight', weight)
    document.documentElement.style.setProperty('--font-weight-clock', family ? weight : clockWeight)
    setFontSize(size)
}

function setFontSize(size: string): void {
    const clamped = Math.min(15, Math.max(7, Number.parseFloat(size)))
    document.documentElement.style.setProperty('--font-size', `${clamped / 16}em`)
}

//
//	Settings options
//

function initFontSettings(font?: Font): void {
    const hasCustomWeights = font && font.weightlist.length > 0
    const weights = hasCustomWeights ? font.weightlist : systemfont.weights
    setWeightSettings(weights)

    // Set the select value after populating options
    setAutocompleteSettings().then(() => {
        const selectFont = document.querySelector<HTMLSelectElement>('#i_customfont')
        if (selectFont && font?.family) {
            selectFont.value = font.family
        }
    })
}

async function setAutocompleteSettings(isLangSwitch?: boolean): Promise<void> {
    const selectFont = document.querySelector<HTMLSelectElement>('#i_customfont')

    if (!selectFont) {
        return
    }

    if (isLangSwitch || selectFont.options.length <= 1) {
        // Clear existing options except the first "System default"
        while (selectFont.options.length > 1) {
            selectFont.remove(1)
        }

        const fontlist = await getFontList()
        const requiredSubset = getRequiredSubset()

        for (const item of fontlist as Fontsource[]) {
            if (item.subsets.includes(requiredSubset)) {
                const option = document.createElement('option')
                option.textContent = item.family
                option.value = item.family
                selectFont.appendChild(option)
            }
        }
    }

    refreshCustomSelects(selectFont.parentElement ?? document)
}

function setWeightSettings(weights: string[]): void {
    const options = document.querySelectorAll<HTMLOptionElement>('#i_weight option')

    for (const option of options) {
        option.classList.toggle('hidden', weights.includes(option.value) === false)
    }
}

//
//	Helpers
//

export async function fontIsAvailableInSubset(lang?: string, family?: string): Promise<boolean | undefined> {
    const fontlist = await getFontList()
    const font = fontlist?.find((item) => item.family === family)
    const subset = getRequiredSubset(lang)

    return font?.subsets.includes(subset)
}

async function getFontList(): Promise<Fontsource[]> {
    if (fontlistCache) {
        return fontlistCache
    }

    try {
        const response = await fetch(FONTS_API)

        if (!response.ok) {
            return []
        }

        fontlistCache = await response.json() as Fontsource[]
        return fontlistCache
    } catch (_) {
        return []
    }
}

function systemFontChecker(family: string): boolean {
    // Needs a special method to detect system fonts.
    // Because of fingerprinting concerns,
    // Firefox and safari made fonts.check() useless

    const p = document.createElement('p')
    p.setAttribute('style', 'position: absolute; opacity: 0; font-family: invalid font;')
    p.textContent = `mqlskdjfhgpaozieurytwnxbcv?./,;:1234567890${tradThis('New tab')}`
    document.getElementById('interface')?.prepend(p)

    const firstW = p.getBoundingClientRect().width
    p.style.fontFamily = `'${family}'`

    const secondW = p.getBoundingClientRect().width
    const hasLoadedFont = firstW !== secondW

    p.remove()

    return hasLoadedFont
}

function waitForFontLoad(family: string): Promise<boolean> {
    return new Promise((resolve) => {
        let limitcounter = 0
        let hasLoadedFont = systemFontChecker(family)

        const interval = setInterval(() => {
            if (hasLoadedFont || limitcounter === 100) {
                clearInterval(interval)
                return resolve(true)
            }

            hasLoadedFont = systemFontChecker(family)
            limitcounter++
        }, 100)
    })
}

function getRequiredSubset(lang: string = getLang()): string {
    let subset = 'latin'

    if (lang in subsets) {
        subset = subsets[lang as keyof typeof subsets]
    }

    return subset
}

// 1.19 migration function
function migrateToNewFormat(font: Font): Font {
    if (font?.weightlist) {
        return font
    }

    if (font.availWeights) {
        font.weightlist = font.availWeights
    }

    font.system = systemFontChecker(font.family)

    font.availWeights = undefined
    font.url = undefined

    storage.local.remove('fontface')
    storage.local.remove('fonts')
    storage.sync.remove('font')
    setTimeout(() => storage.sync.set({ font }))

    return font
}

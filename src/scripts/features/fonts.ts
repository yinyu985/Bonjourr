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

const FONTS_CDN = 'https://cdn.jsdelivr.net/fontsource/fonts'
const FONT_CHOICES: Fontsource[] = [
    {
        id: 'nunito',
        family: 'Nunito',
        subsets: ['latin', 'latin-ext', 'vietnamese'],
        weights: [200, 300, 400, 500, 600, 700, 800, 900],
        variable: true,
    },
    {
        id: 'fira-code',
        family: 'Fira Code',
        subsets: ['latin', 'latin-ext'],
        weights: [300, 400, 500, 600, 700],
        variable: true,
    },
    {
        id: 'merriweather',
        family: 'Merriweather',
        subsets: ['latin', 'latin-ext', 'vietnamese'],
        weights: [300, 400, 700, 900],
        variable: false,
    },
    {
        id: 'rubik',
        family: 'Rubik',
        subsets: ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'hebrew'],
        weights: [300, 400, 500, 600, 700, 800, 900],
        variable: true,
    },
    {
        id: 'cormorant-garamond',
        family: 'Cormorant Garamond',
        subsets: ['latin', 'latin-ext', 'cyrillic', 'vietnamese'],
        weights: [300, 400, 500, 600, 700],
        variable: false,
    },
    {
        id: 'quicksand',
        family: 'Quicksand',
        subsets: ['latin', 'latin-ext', 'vietnamese'],
        weights: [300, 400, 500, 600, 700],
        variable: true,
    },
    {
        id: 'inconsolata',
        family: 'Inconsolata',
        subsets: ['latin', 'latin-ext', 'vietnamese'],
        weights: [200, 300, 400, 500, 600, 700, 800, 900],
        variable: true,
    },
    {
        id: 'bebas-neue',
        family: 'Bebas Neue',
        subsets: ['latin', 'latin-ext'],
        weights: [400],
        variable: false,
    },
    {
        id: 'exo-2',
        family: 'Exo 2',
        subsets: ['latin', 'latin-ext', 'cyrillic', 'vietnamese'],
        weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
        variable: true,
    },
    {
        id: 'rajdhani',
        family: 'Rajdhani',
        subsets: ['latin', 'latin-ext', 'devanagari'],
        weights: [300, 400, 500, 600, 700],
        variable: false,
    },
    {
        id: 'vt323',
        family: 'VT323',
        subsets: ['latin', 'latin-ext', 'vietnamese'],
        weights: [400],
        variable: false,
    },
    {
        id: 'alegreya',
        family: 'Alegreya',
        subsets: ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'vietnamese'],
        weights: [400, 500, 600, 700, 800, 900],
        variable: true,
    },
    {
        id: 'kiwi-maru',
        family: 'Kiwi Maru',
        subsets: ['latin', 'latin-ext', 'japanese'],
        weights: [300, 400, 500],
        variable: false,
    },
    {
        id: 'cormorant',
        family: 'Cormorant',
        subsets: ['latin', 'latin-ext', 'cyrillic', 'vietnamese'],
        weights: [300, 400, 500, 600, 700],
        variable: false,
    },
    {
        id: 'special-elite',
        family: 'Special Elite',
        subsets: ['latin'],
        weights: [400],
        variable: false,
    },
    {
        id: 'doto',
        family: 'Doto',
        subsets: ['latin', 'latin-ext'],
        weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
        variable: true,
    },
    {
        id: 'kode-mono',
        family: 'Kode Mono',
        subsets: ['latin', 'latin-ext'],
        weights: [400, 500, 600, 700],
        variable: true,
    },
]

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
            displayFont(init)
            displayInterface('fonts')

            onSettingsLoad(() => {
                initFontSettings(init)
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
    }

    switch (familyType) {
        case 'fontsource': {
            const newfont = getNewFont(font, family)

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
    setWeightSettings(getWeightsForFont(font.family))
    iWeight.value = font.weight

    return font
}

function handleLangSwitch(font: Font): void {
    const noCustomOrSystemFont = !font.family || font?.system

    if (noCustomOrSystemFont) {
        return
    }

    const newfont = getNewFont(font, font.family)

    // remove font if not available with subset
    if (newfont === undefined) {
        updateCustomFont({ family: '' })
        return
    }

    font.family = newfont.family
    font.weight = newfont.weight

    displayFont(font)
    setAutocompleteSettings(true)
}

function getNewFont(font: Font, newfamily: string): Font | undefined {
    const fontlist = getFontList()
    let newfont: Fontsource | undefined

    for (const item of fontlist) {
        const hasCorrectSubset = fontCanBeSelected(item, getRequiredSubset())
        const isFamily = item.family.toLowerCase() === newfamily.toLowerCase()

        if (hasCorrectSubset && isFamily) {
            newfont = item
        }
    }

    if (newfont) {
        font.weight = '400'
        font.system = false
        font.family = newfont.family
        return font
    }

    // this undefined return is important
    // we need to know when no font is found
    return
}

function displayFont({ family, size, weight, system }: Font): void {
    // Weight: default bonjourr lowers font weight on clock (because we like it)
    const clockWeight = Number.parseInt(weight) > 100
        ? systemfont.weights[systemfont.weights.indexOf(weight) - 1]
        : weight
    const subset = getRequiredSubset()
    const fontId = family.toLocaleLowerCase().replaceAll(' ', '-')
    const fontfacedom = document.getElementById('fontface')
    const fontsource = FONT_CHOICES.find((item) => item.id === fontId || item.family === family)

    // 切字体/语言时**替换**而不是追加；否则 <style id="fontface"> 会越来越胖，
    // 累积所有曾经选过的 @font-face 规则。切到 system 字体也清空。
    if (fontfacedom) {
        if (system) {
            fontfacedom.textContent = ''
        } else {
            let fontface = `
				@font-face {font-family: "${family}";
					font-display: swap;
					src: url(${FONTS_CDN}/${fontId}@latest/latin-${weight}-normal.woff2) format('woff2');
				}
			`

            if (subset !== 'latin' && fontsource?.subsets.includes(subset)) {
                fontface += fontface.replace('latin', subset)
            }

            fontfacedom.textContent = fontface
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
    setWeightSettings(getWeightsForFont(font?.family ?? ''))
    setAutocompleteSettings()

    const selectFont = document.querySelector<HTMLSelectElement>('#i_customfont')
    if (selectFont && font?.family) {
        selectFont.value = font.family
        refreshCustomSelects(selectFont.parentElement ?? document)
    }
}

function setAutocompleteSettings(isLangSwitch?: boolean): void {
    const selectFont = document.querySelector<HTMLSelectElement>('#i_customfont')

    if (!selectFont) {
        return
    }

    if (isLangSwitch || selectFont.options.length === 0) {
        while (selectFont.options.length > 0) {
            selectFont.remove(0)
        }

        const fontlist = getFontList()
        const requiredSubset = getRequiredSubset()

        for (const item of fontlist) {
            if (fontCanBeSelected(item, requiredSubset)) {
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

export function fontIsAvailableInSubset(lang?: string, family?: string): boolean | undefined {
    const fontlist = getFontList()
    const font = fontlist?.find((item) => item.family === family)
    const subset = getRequiredSubset(lang)

    return font ? fontCanBeSelected(font, subset) : undefined
}

function getFontList(): Fontsource[] {
    return FONT_CHOICES
}

function fontCanBeSelected(font: Fontsource, subset: string): boolean {
    return font.subsets.includes(subset) || font.subsets.includes('latin')
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

async function waitForFontLoad(family: string): Promise<boolean> {
    // 浏览器原生 FontFaceSet API：直接告诉它"我要用这个字体"，
    // 浏览器加载完成 resolve；失败也 resolve（catch 内部），10s 超时兜底。
    // 比原来的 setInterval 每 100ms 创建/测量/删 <p> 元素轻得多。
    try {
        await Promise.race([
            document.fonts.load(`16px "${family}"`),
            new Promise((resolve) => setTimeout(resolve, 10_000)),
        ])
    } catch (_) {
        // 字体加载失败也继续，让调用方走默认渲染路径。
    }
    return true
}

function getRequiredSubset(lang: string = getLang()): string {
    let subset = 'latin'

    if (lang in subsets) {
        subset = subsets[lang as keyof typeof subsets]
    }

    return subset
}

function getWeightsForFont(family: string): string[] {
    const fontId = family.toLocaleLowerCase().replaceAll(' ', '-')
    const source = FONT_CHOICES.find((item) => item.id === fontId || item.family === family)
    return source ? source.weights.map((w) => w.toString()) : systemfont.weights
}

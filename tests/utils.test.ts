import './init.test.ts'

import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert'
import {
    getReadableTextColor,
    hexToHSL,
    hexToRGB,
    opacityFromHex,
    rgbToHex,
    stringMaxSize,
} from '../src/scripts/shared/generic.ts'
import { parse } from '../src/scripts/utils/parse.ts'
import { stringify } from '../src/scripts/utils/stringify.ts'
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import { buildNativeFaviconUrl, DEFAULT_FAVICON, getDefaultIcon } from '../src/scripts/features/links/helpers.ts'
import { darkmode, favicon } from '../src/scripts/features/others.ts'
import { onclickdown } from '../src/scripts/utils/clickdown.ts'

// parse

Deno.test('parse returns parsed JSON', () => {
    assertEquals(parse<{ a: number }>('{"a":1}'), { a: 1 })
})

Deno.test('parse returns undefined for invalid JSON', () => {
    assertEquals(parse('not json'), undefined)
})

Deno.test('parse returns undefined for empty string', () => {
    assertEquals(parse(''), undefined)
})

Deno.test('parse handles arrays', () => {
    const result = parse<number[]>('[1,2,3]')
    assertEquals(result, [1, 2, 3])
})

Deno.test('onclickdown invokes checkbox actions once across pointerdown and click', () => {
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    let calls = 0
    onclickdown(checkbox, () => {
        calls += 1
    })

    checkbox.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    assertEquals(calls, 1)
})

// stringify

Deno.test('stringify produces valid JSON from Sync data', () => {
    const data = structuredClone(SYNC_DEFAULT)
    const json = stringify(data)
    const parsed = JSON.parse(json)

    assertEquals(parsed.lang, data.lang)
    assertEquals(parsed.time, data.time)
})

Deno.test('stringify preserves key order from defaults', () => {
    const data = structuredClone(SYNC_DEFAULT)
    const json = stringify(data)
    const keys = Object.keys(JSON.parse(json))

    assert(keys.indexOf('about') < keys.indexOf('links'))
})

Deno.test('stringify handles partial data', () => {
    const json = stringify({ lang: 'fr', time: false })
    const parsed = JSON.parse(json)

    assertEquals(parsed.lang, 'fr')
    assertEquals(parsed.time, false)
})

// stringMaxSize

Deno.test('stringMaxSize returns original if within limit', () => {
    assertEquals(stringMaxSize('hello', 10), 'hello')
})

Deno.test('stringMaxSize truncates if over limit', () => {
    assertEquals(stringMaxSize('hello world', 5), 'hello')
})

Deno.test('stringMaxSize handles exact boundary', () => {
    assertEquals(stringMaxSize('hello', 5), 'hello')
})

// favicons

Deno.test('native favicon URL keeps bookmark domains inside the extension API', () => {
    const icon = buildNativeFaviconUrl(
        'https://private.example/account?secret=1',
        'chrome-extension://extension-id/_favicon/',
    )

    assertStringIncludes(icon, 'chrome-extension://extension-id/_favicon/')
    assertEquals(new URL(icon).searchParams.get('pageUrl'), 'https://private.example/account?secret=1')
    assert(!icon.includes('duckduckgo.com'))
})

Deno.test('invalid favicon input uses the bundled fallback without a network URL', () => {
    assertEquals(getDefaultIcon('not a URL'), DEFAULT_FAVICON)
})

Deno.test('clearing a custom tab favicon restores the original icon', () => {
    const original = document.querySelector('#favicon')
    const icon = document.createElement('link')
    icon.id = 'favicon'
    icon.href = 'https://example.com/default.svg'
    original?.replaceWith(icon)
    if (!original) document.head.appendChild(icon)

    favicon('🌟')
    assert(icon.href.startsWith('data:image/svg+xml,'))
    favicon('')
    assertEquals(icon.href, 'https://example.com/default.svg')

    icon.remove()
    if (original) document.head.appendChild(original)
})

Deno.test('default font uses the local system stack', () => {
    assertEquals(SYNC_DEFAULT.font.family, '')
    assertEquals(SYNC_DEFAULT.font.system, true)
})

Deno.test('system theme listener is removed before a fixed theme is applied', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia')
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    const query = {
        matches: true,
        media: '(prefers-color-scheme: dark)',
        onchange: null,
        addEventListener: (_type: string, listener: EventListenerOrEventListenerObject): void => {
            listeners.add(listener as (event: MediaQueryListEvent) => void)
        },
        removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject): void => {
            listeners.delete(listener as (event: MediaQueryListEvent) => void)
        },
    } as unknown as MediaQueryList

    Object.defineProperty(globalThis, 'matchMedia', {
        configurable: true,
        value: (): MediaQueryList => query,
    })

    try {
        darkmode('system')
        assertEquals(document.documentElement.dataset.theme, 'dark')
        assertEquals(listeners.size, 1)

        darkmode('disable')
        assertEquals(document.documentElement.dataset.theme, 'light')
        assertEquals(listeners.size, 0)

        for (const listener of listeners) listener({ matches: true } as MediaQueryListEvent)
        assertEquals(document.documentElement.dataset.theme, 'light')
    } finally {
        darkmode('disable')
        if (descriptor) {
            Object.defineProperty(globalThis, 'matchMedia', descriptor)
        } else {
            Reflect.deleteProperty(globalThis, 'matchMedia')
        }
    }
})

Deno.test('every locale contains the complete non-empty English translation key set', () => {
    const localesRoot = new URL('../_locales/', import.meta.url)
    const english = JSON.parse(Deno.readTextFileSync(new URL('en/translations.json', localesRoot))) as Record<
        string,
        string
    >
    const expectedKeys = Object.keys(english).sort()

    for (const entry of Deno.readDirSync(localesRoot)) {
        if (!entry.isDirectory || entry.name === 'en') continue

        const translations = JSON.parse(
            Deno.readTextFileSync(new URL(`${entry.name}/translations.json`, localesRoot)),
        ) as Record<string, string>
        assertEquals(Object.keys(translations).sort(), expectedKeys, `${entry.name} translation keys differ`)
        assert(
            Object.values(translations).every((value) => typeof value === 'string' && value.trim().length > 0),
            `${entry.name} contains an empty translation`,
        )
    }
})

// opacityFromHex

Deno.test('opacityFromHex extracts alpha from short hex', () => {
    assertEquals(opacityFromHex('#ffff'), 15)
    assertEquals(opacityFromHex('#fff0'), 0)
    assertEquals(opacityFromHex('#fff2'), 2)
})

// rgbToHex

Deno.test('rgbToHex converts RGB to hex string', () => {
    assertEquals(rgbToHex(255, 255, 255), '#ffffff')
    assertEquals(rgbToHex(0, 0, 0), '#000000')
    assertEquals(rgbToHex(255, 0, 128), '#ff0080')
})

// hexToRGB

Deno.test('hexToRGB converts hex to RGB object', () => {
    const { r, g, b } = hexToRGB('#ff0080')
    assertEquals(r, 255)
    assertEquals(g, 0)
    assertEquals(b, 128)
})

Deno.test('hexToRGB handles black', () => {
    const { r, g, b } = hexToRGB('#000000')
    assertEquals(r, 0)
    assertEquals(g, 0)
    assertEquals(b, 0)
})

// hexToHSL

Deno.test('hexToHSL converts pure red', () => {
    const { h, s, l } = hexToHSL('#ff0000')
    assertEquals(h, 0)
    assertEquals(s, 100)
    assertEquals(l, 50)
})

Deno.test('hexToHSL converts white', () => {
    const { h, s, l } = hexToHSL('#ffffff')
    assertEquals(h, 0)
    assertEquals(s, 0)
    assertEquals(l, 100)
})

Deno.test('hexToHSL handles shorthand hex', () => {
    const { h, s, l } = hexToHSL('#f00')
    assertEquals(h, 0)
    assertEquals(s, 100)
    assertEquals(l, 50)
})

Deno.test('hexToHSL throws on invalid hex', () => {
    assertThrows(() => hexToHSL('#gg'))
})

// getReadableTextColor

Deno.test('getReadableTextColor returns white on dark backgrounds', () => {
    assertEquals(getReadableTextColor({ r: 0, g: 0, b: 0 }), 'white')
    assertEquals(getReadableTextColor({ r: 50, g: 50, b: 50 }), 'white')
})

Deno.test('getReadableTextColor returns black on light backgrounds', () => {
    assertEquals(getReadableTextColor({ r: 255, g: 255, b: 255 }), 'black')
    assertEquals(getReadableTextColor({ r: 200, g: 200, b: 200 }), 'black')
})

import './init.test.ts'

import { assert, assertEquals, assertThrows } from '@std/assert'
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

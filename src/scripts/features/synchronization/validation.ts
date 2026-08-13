import { SYNC_DEFAULT } from '../../defaults.ts'
import { langList } from '../../langs.ts'

import type { Sync } from '../../../types/sync.ts'

const MAX_CONFIG_CHARS = 4_000_000
const MAX_BOOKMARK_DEPTH = 64
const MAX_BOOKMARK_NODES = 100_000
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Reject malformed or hostile imported/remote data before any bookmark or
 * background side effect is attempted. Partial configs are valid, but every
 * supplied field must have the shape of the current schema.
 */
export function assertValidSyncInput(value: unknown): asserts value is Partial<Sync> {
    if (!isRecord(value)) throw new Error('Invalid configuration: expected an object')

    let serialized = ''
    try {
        serialized = JSON.stringify(value)
    } catch {
        throw new Error('Invalid configuration: data is not serializable')
    }
    if (serialized.length > MAX_CONFIG_CHARS) {
        throw new Error('Invalid configuration: data is too large')
    }

    assertNoUnsafeKeys(value, 'configuration')
    assertKnownConfigurationFields(value)
    assertTemplateFields(value, SYNC_DEFAULT as unknown as Record<string, unknown>, 'configuration', false)
    assertEnums(value)
    assertOptionalFields(value)
    assertBoundedTextFields(value)
    assertSupportedValues(value)
    assertBookmarkSnapshot(value)
    assertNotes(value)
}

function assertBoundedTextFields(value: Record<string, unknown>): void {
    assertMaxString(value.favicon, 64, 'configuration.favicon')
    assertMaxString(value.tabtitle, 80, 'configuration.tabtitle')
    assertMaxString(value.css, 8080, 'configuration.css')

    if (isRecord(value.font)) {
        assertMaxString(value.font.family, 200, 'configuration.font.family')
        if (
            value.font.weight !== undefined &&
            !['100', '200', '300', '400', '500', '600', '700', '800', '900'].includes(String(value.font.weight))
        ) {
            throw new Error('Invalid configuration: unsupported configuration.font.weight')
        }
        if (value.font.size !== undefined) {
            const size = Number(value.font.size)
            if (!Number.isFinite(size) || size < 7 || size > 15) {
                throw new Error('Invalid configuration: configuration.font.size is outside its supported range')
            }
        }
    }

    if (isRecord(value.backgrounds)) {
        assertMaxString(value.backgrounds.urls, 8080, 'configuration.backgrounds.urls')
        assertMaxString(value.backgrounds.query, 200, 'configuration.backgrounds.query')
        assertMaxString(value.backgrounds.images, 256, 'configuration.backgrounds.images')
        assertHexColor(value.backgrounds.color, 'configuration.backgrounds.color')
        if (isRecord(value.backgrounds.texture)) {
            assertHexColor(value.backgrounds.texture.color, 'configuration.backgrounds.texture.color')
        }
        if (isRecord(value.backgrounds.pausedImage)) {
            assertHexColor(value.backgrounds.pausedImage.color, 'configuration.backgrounds.pausedImage.color')
        }
    }

    if (isRecord(value.clock)) {
        assertMaxString(value.clock.timezone, 100, 'configuration.clock.timezone')
    }
}

function assertMaxString(value: unknown, maximum: number, path: string): void {
    if (typeof value === 'string' && value.length > maximum) {
        throw new Error(`Invalid configuration: ${path} is too long`)
    }
}

function assertHexColor(value: unknown, path: string): void {
    if (value !== undefined && (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value))) {
        throw new Error(`Invalid configuration: ${path} must be a six-digit HEX color`)
    }
}

function assertSupportedValues(value: Record<string, unknown>): void {
    assertNumberRange(value.textShadow, 0, 1, 'configuration.textShadow')

    if (isRecord(value.links)) {
        assertNumberRange(value.links.rows, 1, 64, 'configuration.links.rows', true)
        assertNumberRange(value.links.iconRadius, 0, 5, 'configuration.links.iconRadius')
    }
    if (isRecord(value.clock)) {
        assertNumberRange(value.clock.size, 0.5, 2, 'configuration.clock.size')
    }
    if (isRecord(value.backgrounds)) {
        assertNumberRange(value.backgrounds.blur, 0, 50, 'configuration.backgrounds.blur')
        assertNumberRange(value.backgrounds.bright, 0.2, 1, 'configuration.backgrounds.bright')
        if (isRecord(value.backgrounds.texture)) {
            assertNumberRange(value.backgrounds.texture.opacity, 0, 1, 'configuration.backgrounds.texture.opacity')
            assertNumberRange(value.backgrounds.texture.size, 1, 1000, 'configuration.backgrounds.texture.size')
        }
    }
}

function assertNumberRange(value: unknown, minimum: number, maximum: number, path: string, integer = false): void {
    if (value === undefined) return
    if (
        typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum ||
        (integer && !Number.isInteger(value))
    ) {
        throw new Error(`Invalid configuration: ${path} is outside its supported range`)
    }
}

function assertKnownConfigurationFields(value: Record<string, unknown>): void {
    assertAllowedKeys(value, [...Object.keys(SYNC_DEFAULT), 'showall'], 'configuration')

    if (isRecord(value.links)) {
        assertAllowedKeys(
            value.links,
            [...Object.keys(SYNC_DEFAULT.links), 'folders', 'favorites', 'toolbarOrder'],
            'configuration.links',
        )
    }
    if (isRecord(value.clock)) {
        assertAllowedKeys(value.clock, [...Object.keys(SYNC_DEFAULT.clock), 'analog'], 'configuration.clock')
    }
    if (isRecord(value.font)) {
        assertAllowedKeys(value.font, Object.keys(SYNC_DEFAULT.font), 'configuration.font')
    }
    if (isRecord(value.hide)) {
        assertAllowedKeys(value.hide, ['clock', 'date'], 'configuration.hide')
    }
    if (isRecord(value.backgrounds)) {
        assertAllowedKeys(
            value.backgrounds,
            [...Object.keys(SYNC_DEFAULT.backgrounds), 'pausedUrl', 'pausedImage', 'mute', 'fadein', 'queries'],
            'configuration.backgrounds',
        )
        if (isRecord(value.backgrounds.texture)) {
            assertAllowedKeys(
                value.backgrounds.texture,
                Object.keys(SYNC_DEFAULT.backgrounds.texture),
                'configuration.backgrounds.texture',
            )
        }
        if (isRecord(value.backgrounds.pausedImage)) {
            assertAllowedKeys(
                value.backgrounds.pausedImage,
                [
                    'id',
                    'format',
                    'mimetype',
                    'urls',
                    'page',
                    'username',
                    'color',
                    'name',
                    'city',
                    'country',
                    'download',
                    'exif',
                ],
                'configuration.backgrounds.pausedImage',
            )
            if (isRecord(value.backgrounds.pausedImage.urls)) {
                assertAllowedKeys(
                    value.backgrounds.pausedImage.urls,
                    ['full', 'small'],
                    'configuration.backgrounds.pausedImage.urls',
                )
            }
        }
    }
    if (isRecord(value.notes)) {
        assertAllowedKeys(value.notes, ['active', 'records'], 'configuration.notes')
        if (Array.isArray(value.notes.records)) {
            for (const [index, note] of value.notes.records.entries()) {
                if (isRecord(note)) {
                    assertAllowedKeys(
                        note,
                        ['id', 'title', 'content', 'updatedAt'],
                        `configuration.notes.records.${index}`,
                    )
                }
            }
        }
    }
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
    const allowedKeys = new Set(allowed)
    for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) throw new Error(`Invalid configuration: unknown field ${path}.${key}`)
    }
}

/** Validate the complete normalized value immediately before it is applied. */
export function assertValidNormalizedSync(value: unknown): asserts value is Sync {
    assertValidSyncInput(value)
    assertTemplateFields(
        value as Record<string, unknown>,
        SYNC_DEFAULT as unknown as Record<string, unknown>,
        'configuration',
        true,
    )
}

function assertTemplateFields(
    value: Record<string, unknown>,
    template: Record<string, unknown>,
    path: string,
    requireAll: boolean,
): void {
    for (const [key, expected] of Object.entries(template)) {
        if (!(key in value)) {
            if (requireAll && !isOptionalPath(`${path}.${key}`)) {
                throw new Error(`Invalid configuration: missing ${path}.${key}`)
            }
            continue
        }

        const actual = value[key]
        const field = `${path}.${key}`
        if (Array.isArray(expected)) {
            if (!Array.isArray(actual)) throw new Error(`Invalid configuration: ${field} must be an array`)
        } else if (isRecord(expected)) {
            if (!isRecord(actual)) throw new Error(`Invalid configuration: ${field} must be an object`)
            assertTemplateFields(actual, expected, field, requireAll)
        } else if (typeof actual !== typeof expected) {
            throw new Error(`Invalid configuration: ${field} has the wrong type`)
        } else if (typeof actual === 'number' && !Number.isFinite(actual)) {
            throw new Error(`Invalid configuration: ${field} must be a finite number`)
        }
    }
}

function assertEnums(value: Record<string, unknown>): void {
    assertEnum(value.lang, Object.keys(langList), 'configuration.lang')
    assertEnum(value.dark, ['auto', 'system', 'enable', 'disable'], 'configuration.dark')
    assertEnum(value.dateformat, ['auto', 'eu', 'us', 'cn'], 'configuration.dateformat')

    if (isRecord(value.links)) {
        assertEnum(value.links.style, ['inline', 'text'], 'configuration.links.style')
    }
    if (isRecord(value.backgrounds)) {
        assertEnum(value.backgrounds.type, ['files', 'urls', 'images', 'color'], 'configuration.backgrounds.type')
        assertEnum(
            value.backgrounds.frequency,
            ['tabs', 'hour', 'day', 'period', 'pause'],
            'configuration.backgrounds.frequency',
        )
        if (isRecord(value.backgrounds.texture)) {
            assertEnum(
                value.backgrounds.texture.type,
                [
                    'none',
                    'grain',
                    'verticalDots',
                    'diagonalDots',
                    'topographic',
                    'checkerboard',
                    'isometric',
                    'grid',
                    'verticalLines',
                    'horizontalLines',
                    'diagonalStripes',
                    'verticalStripes',
                    'horizontalStripes',
                    'diagonalLines',
                    'aztec',
                    'circuitBoard',
                    'ticTacToe',
                    'endlessClouds',
                    'vectorGrain',
                    'waves',
                    'honeycomb',
                ],
                'configuration.backgrounds.texture.type',
            )
        }
    }
}

function assertEnum(value: unknown, allowed: string[], path: string): void {
    if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value))) {
        throw new Error(`Invalid configuration: unsupported ${path}`)
    }
}

function assertOptionalFields(value: Record<string, unknown>): void {
    if (value.hide !== undefined) {
        if (!isRecord(value.hide)) throw new Error('Invalid configuration: configuration.hide must be an object')
        for (const key of ['clock', 'date']) {
            const field = value.hide[key]
            if (field !== undefined && typeof field !== 'boolean') {
                throw new Error(`Invalid configuration: configuration.hide.${key} must be a boolean`)
            }
        }
    }

    const backgrounds = value.backgrounds
    if (!isRecord(backgrounds)) return
    for (const key of ['pausedUrl']) {
        if (backgrounds[key] !== undefined && typeof backgrounds[key] !== 'string') {
            throw new Error(`Invalid configuration: configuration.backgrounds.${key} must be a string`)
        }
    }
    if (backgrounds.pausedImage !== undefined && !isRecord(backgrounds.pausedImage)) {
        throw new Error('Invalid configuration: configuration.backgrounds.pausedImage must be an object')
    }
    if (isRecord(backgrounds.pausedImage)) {
        const image = backgrounds.pausedImage
        if (image.format !== 'image' || !isRecord(image.urls)) {
            throw new Error('Invalid configuration: malformed paused background image')
        }
        if (typeof image.urls.full !== 'string' || typeof image.urls.small !== 'string') {
            throw new Error('Invalid configuration: paused background URLs must be strings')
        }
        assertHttpsUrl(image.urls.full, 'configuration.backgrounds.pausedImage.urls.full')
        assertHttpsUrl(image.urls.small, 'configuration.backgrounds.pausedImage.urls.small')
        for (const key of ['id', 'mimetype', 'page', 'username', 'color', 'name', 'city', 'country', 'download']) {
            if (image[key] !== undefined && typeof image[key] !== 'string') {
                throw new Error(`Invalid configuration: paused background ${key} must be a string`)
            }
        }
        if (typeof image.page === 'string') {
            assertHttpsUrl(image.page, 'configuration.backgrounds.pausedImage.page')
        }
        if (typeof image.download === 'string') {
            assertHttpsUrl(image.download, 'configuration.backgrounds.pausedImage.download')
        }
    }
}

function assertHttpsUrl(value: string, path: string): void {
    try {
        if (new URL(value).protocol === 'https:') return
    } catch (_) {
        // Fall through to one consistent validation error.
    }
    throw new Error(`Invalid configuration: ${path} must be an HTTPS URL`)
}

function assertBookmarkSnapshot(value: Record<string, unknown>): void {
    if (!isRecord(value.links)) return
    const { folders, favorites, toolbarOrder } = value.links
    let nodeCount = 0
    const bookmarkIds = new Set<string>()
    const topLevelIds = new Set<string>()

    if (folders !== undefined) {
        if (!Array.isArray(folders)) throw new Error('Invalid configuration: links.folders must be an array')
        for (const folder of folders) {
            assertBookmarkNode(folder, 'folder', 0)
            topLevelIds.add((folder as { id: string }).id)
        }
    }
    if (favorites !== undefined) {
        if (!Array.isArray(favorites)) throw new Error('Invalid configuration: links.favorites must be an array')
        for (const favorite of favorites) {
            assertBookmarkNode(favorite, 'bookmark', 0)
            topLevelIds.add((favorite as { id: string }).id)
        }
    }
    if (toolbarOrder !== undefined) {
        if (!Array.isArray(toolbarOrder) || toolbarOrder.some((id) => typeof id !== 'string')) {
            throw new Error('Invalid configuration: links.toolbarOrder must contain only strings')
        }
        const orderedIds = new Set(toolbarOrder)
        if (orderedIds.size !== toolbarOrder.length) {
            throw new Error('Invalid configuration: links.toolbarOrder contains duplicate ids')
        }
        if (
            Array.isArray(folders) && Array.isArray(favorites) &&
            (orderedIds.size !== topLevelIds.size || [...topLevelIds].some((id) => !orderedIds.has(id)))
        ) {
            throw new Error('Invalid configuration: links.toolbarOrder does not match the bookmark snapshot')
        }
    }

    function assertBookmarkNode(node: unknown, kind: 'folder' | 'bookmark' | 'either', depth: number): void {
        nodeCount += 1
        if (nodeCount > MAX_BOOKMARK_NODES || depth > MAX_BOOKMARK_DEPTH) {
            throw new Error('Invalid configuration: bookmark tree is too large')
        }
        if (!isRecord(node) || typeof node.id !== 'string' || !node.id || typeof node.title !== 'string') {
            throw new Error('Invalid configuration: malformed bookmark node')
        }
        if (bookmarkIds.has(node.id)) throw new Error(`Invalid configuration: duplicate bookmark id ${node.id}`)
        bookmarkIds.add(node.id)

        if ('items' in node) {
            assertAllowedKeys(node, ['id', 'title', 'items'], 'configuration.links.bookmark')
            if (kind === 'bookmark') throw new Error('Invalid configuration: favorite must be a bookmark')
            if (!Array.isArray(node.items)) throw new Error('Invalid configuration: folder items must be an array')
            for (const child of node.items) assertBookmarkNode(child, 'either', depth + 1)
        } else {
            assertAllowedKeys(node, ['id', 'title', 'url'], 'configuration.links.bookmark')
            if (kind === 'folder' || typeof node.url !== 'string' || node.url.length === 0) {
                throw new Error('Invalid configuration: malformed bookmark or folder')
            }
        }
    }
}

function isOptionalPath(path: string): boolean {
    return [
        'configuration.hide',
        'configuration.notes',
        'configuration.font.system',
        'configuration.backgrounds.texture.size',
        'configuration.backgrounds.texture.opacity',
        'configuration.backgrounds.texture.color',
    ].includes(path)
}

function assertNotes(value: Record<string, unknown>): void {
    if (!isRecord(value.notes) || value.notes.records === undefined) return
    if (!Array.isArray(value.notes.records)) {
        throw new Error('Invalid configuration: notes.records must be an array')
    }
    for (const note of value.notes.records) {
        if (!isRecord(note) || ['id', 'title', 'content', 'updatedAt'].some((key) => typeof note[key] !== 'string')) {
            throw new Error('Invalid configuration: malformed note')
        }
    }
}

function assertNoUnsafeKeys(value: unknown, path: string): void {
    if (!isRecord(value) && !Array.isArray(value)) return
    for (const [key, nested] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key)) throw new Error(`Invalid configuration: unsafe key at ${path}`)
        if (isRecord(nested) || Array.isArray(nested)) assertNoUnsafeKeys(nested, `${path}.${key}`)
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

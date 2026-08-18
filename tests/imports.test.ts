import './init.test.ts'

// Import script after test init, document needs to be loaded first
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import { mergeImportedConfig, removeDeprecatedFields } from '../src/scripts/compatibility/apply.ts'
import { assertValidNormalizedSync } from '../src/scripts/features/synchronization/validation.ts'
import { assert } from '@std/assert'
import { resetBackgroundRuntimeCache } from '../src/scripts/features/backgrounds/cache.ts'
import type { Sync } from '../src/types/sync.ts'

const defaults = structuredClone(SYNC_DEFAULT)

Deno.test({
    name: 'Global exists',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        assert(globalThis.document)
    },
})

Deno.test({
    name: 'Filter imports is working',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        mergeImportedConfig(defaults, {})
    },
})

Deno.test('Partial import keeps defaults for missing keys', () => {
    const imported = {
        time: false,
        lang: 'en',
    } as Record<string, unknown>
    const config = mergeImportedConfig(defaults, imported)

    assert(defaults.time !== config.time)
    assert(defaults.lang === config.lang)
})

Deno.test('Native partial import merge preserves nested siblings and appends array entries', () => {
    const current = structuredClone(SYNC_DEFAULT)
    current.font.family = 'Existing font'
    current.notes = {
        active: 'first',
        records: [{ id: 'first', title: 'First', content: 'one', updatedAt: '2026-01-01T00:00:00.000Z' }],
    }
    const incoming = {
        font: { weight: '700' },
        notes: {
            records: [{ id: 'second', title: 'Second', content: 'two', updatedAt: '2026-01-02T00:00:00.000Z' }],
        },
    } as unknown as Partial<Sync>

    const config = mergeImportedConfig(current, incoming)

    assert(config.font.family === 'Existing font')
    assert(config.font.weight === '700')
    assert(config.notes?.active === 'first')
    assert(config.notes?.records.map((note) => note.id).join(',') === 'first,second')
})

Deno.test('Full import replaces current entirely', () => {
    const incoming = structuredClone(SYNC_DEFAULT)
    incoming.tabtitle = 'replaced'
    const config = mergeImportedConfig(defaults, incoming)

    assert(config.tabtitle === 'replaced')
})

Deno.test('Legacy show-all preference is discarded because advanced settings are always visible', () => {
    const incoming = { ...structuredClone(SYNC_DEFAULT), showall: false }
    const config = mergeImportedConfig(structuredClone(SYNC_DEFAULT), incoming)

    assert(!('showall' in config))
})

Deno.test('Image import without texture does not inherit default texture', () => {
    const incoming = {
        backgrounds: {
            pausedImage: {
                format: 'image',
                urls: {
                    full: 'https://example.com/full.jpg',
                    small: 'https://example.com/small.jpg',
                },
            },
        },
    } as unknown as Partial<Sync>
    const config = mergeImportedConfig(structuredClone(SYNC_DEFAULT), incoming)

    assert(config.backgrounds.type === 'images')
    assert(config.backgrounds.frequency === 'pause')
    assert(config.backgrounds.texture.type === 'none')
})

Deno.test('Full config import with pausedImage and default topographic texture overrides to none', () => {
    const incoming = structuredClone(SYNC_DEFAULT)
    incoming.backgrounds.type = 'images'
    incoming.backgrounds.frequency = 'pause'
    incoming.backgrounds.pausedImage = {
        format: 'image',
        urls: {
            full: 'https://example.com/full.jpg',
            small: 'https://example.com/small.jpg',
        },
    }
    // texture is already topographic from SYNC_DEFAULT

    const config = mergeImportedConfig(structuredClone(SYNC_DEFAULT), incoming)

    assert(config.backgrounds.type === 'images')
    assert(config.backgrounds.frequency === 'pause')
    assert(
        config.backgrounds.texture.type === 'none',
        'topographic default should be overridden to none when importing a pausedImage config',
    )
})

Deno.test('Full config import with pausedImage and explicit non-default texture keeps it', () => {
    const incoming = structuredClone(SYNC_DEFAULT)
    incoming.backgrounds.type = 'images'
    incoming.backgrounds.frequency = 'pause'
    incoming.backgrounds.pausedImage = {
        format: 'image',
        urls: {
            full: 'https://example.com/full.jpg',
            small: 'https://example.com/small.jpg',
        },
    }
    incoming.backgrounds.texture = { type: 'grain' }

    const config = mergeImportedConfig(structuredClone(SYNC_DEFAULT), incoming)

    assert(config.backgrounds.type === 'images')
    assert(config.backgrounds.frequency === 'pause')
    assert(config.backgrounds.texture.type === 'grain', 'explicit non-default texture should be preserved')
})

Deno.test('Background runtime reset applies imported texture immediately', async () => {
    document.body.insertAdjacentHTML(
        'beforeend',
        `
            <div id="background-wrapper" class="hidden" data-type="color" data-texture="topographic">
                <div id="background-media"></div>
                <div id="background-texture"></div>
            </div>
        `,
    )

    try {
        const backgrounds = structuredClone(SYNC_DEFAULT.backgrounds)
        backgrounds.type = 'images'
        backgrounds.frequency = 'pause'
        backgrounds.texture = { type: 'none' }
        backgrounds.pausedImage = {
            format: 'image',
            urls: {
                full: 'https://example.com/full.jpg',
                small: 'https://example.com/small.jpg',
            },
            color: '#123456',
        }

        await resetBackgroundRuntimeCache(backgrounds)

        const wrapper = document.getElementById('background-wrapper')

        assert(wrapper?.dataset.type === 'images')
        assert(wrapper?.dataset.texture === 'none')
        assert(document.querySelector('#background-media .background-image'))
    } finally {
        document.getElementById('background-wrapper')?.remove()
        localStorage.removeItem('backgroundCache')
        localStorage.removeItem('backgroundPreloadingAt')
    }
})

Deno.test('legacy remote config with retired urls background migrates instead of failing validation', () => {
    const incoming = structuredClone(SYNC_DEFAULT)
    const backgrounds = incoming.backgrounds as unknown as Record<string, unknown>
    backgrounds.type = 'urls'
    backgrounds.urls = 'https://example.com/x.png'
    backgrounds.pausedUrl = 'https://example.com/x.png'

    removeDeprecatedFields(incoming)

    assert(!('urls' in incoming.backgrounds))
    assert(!('pausedUrl' in incoming.backgrounds))
    assert(incoming.backgrounds.type === 'color')

    // After stripping, the normalized value must pass strict validation.
    assertValidNormalizedSync(incoming)
})

Deno.test('legacy remote config with images type plus urls field keeps images and drops urls', () => {
    const incoming = structuredClone(SYNC_DEFAULT)
    const backgrounds = incoming.backgrounds as unknown as Record<string, unknown>
    backgrounds.type = 'images'
    backgrounds.images = 'unsplash-images-search'
    backgrounds.query = 'sea'
    backgrounds.urls = ''

    removeDeprecatedFields(incoming)

    assert(!('urls' in incoming.backgrounds))
    assert(incoming.backgrounds.type === 'images')
    assert(incoming.backgrounds.images === 'unsplash-images-search')
    assert(incoming.backgrounds.query === 'sea')

    assertValidNormalizedSync(incoming)
})

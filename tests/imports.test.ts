import './init.test.ts'

// Import script after test init, document needs to be loaded first
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import { mergeImportedConfig } from '../src/scripts/compatibility/apply.ts'
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

Deno.test('Full import replaces current entirely', () => {
    const incoming = structuredClone(SYNC_DEFAULT)
    incoming.tabtitle = 'replaced'
    const config = mergeImportedConfig(defaults, incoming)

    assert(config.tabtitle === 'replaced')
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

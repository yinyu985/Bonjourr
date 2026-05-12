import './init.test.ts'

// Import script after test init, document needs to be loaded first
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import { filterData } from '../src/scripts/compatibility/apply.ts'
import { assert } from '@std/assert'

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
        filterData('import', defaults, {})
    },
})

Deno.test('Current version small import', () => {
    const imported = {
        time: false,
        main: true,
        lang: 'en',
    } as Record<string, unknown>
    const config = filterData('import', defaults, imported)

    assert(defaults.time !== config.time)
    assert(defaults.lang === config.lang)
    assert('main' in config === false)
})

Deno.test('1.10.0', async (t) => {
    const text = Deno.readTextFileSync('./tests/configs/10.0.0.json')
    const old = JSON.parse(text)
    const res = filterData('import', defaults, old)

    await t.step('Links', async (t) => {
        const defaultGroup = res.links.folders.find((group) => group.id === 'default')

        await t.step('Legacy links are ignored by runtime imports', () => {
            assert(defaultGroup)
            assert((defaultGroup?.items.length ?? 0) === 0)
        })
    })

    await t.step('Clock', () => {
        assert(res.dateformat === 'us')
    })

    await t.step('Backgrounds', () => {
        assert(old.background_blur === res.backgrounds.blur)
    })

    await t.step('Removed widgets', async (t) => {
        await t.step('Searchbar removed', () => {
            assert('searchbar' in res === false)
        })

        await t.step('Weather removed', () => {
            assert('weather' in res === false)
        })

        await t.step('Greeting removed', () => {
            assert('greeting' in res === false)
        })
    })

    await t.step('Hide', () => {
        assert(Array.isArray(res.hide) === false)
    })

    await t.step('Review', () => {
        assert(res.review === -1)
    })
})

Deno.test('20.4.2', async (t) => {
    const text = Deno.readTextFileSync('./tests/configs/20.4.2.json')
    const old = JSON.parse(text)
    const res = filterData('import', defaults, old)

    await t.step('Backgrounds', async (t) => {
        await t.step('Local type', () => {
            assert(res.backgrounds.type === 'files')
        })

        await t.step('Blur', () => {
            assert(old.background_blur === res.backgrounds.blur)
        })

        await t.step('Bright', () => {
            assert(old.background_bright === res.backgrounds.bright)
        })

        await t.step('Unsplash collection', () => {
            assert(old.unsplash.collection === res.backgrounds.queries['unsplash-images-collections'])
        })

        await t.step('Frequency', () => {
            assert(old.unsplash.every === res.backgrounds.frequency)
        })
    })

    await t.step('Links', async (t) => {
        await t.step('Legacy link groups are ignored by runtime imports', () => {
            assert(res.links.folders.length === 1)
            assert(res.links.folders[0].id === 'default')
            assert(res.links.folders[0].items.length === 0)
        })
    })

    await t.step('Removed widgets', () => {
        assert('main' in res === false)
        assert('weather' in res === false)
        assert('searchbar' in res === false)
        assert('quotes' in res === false)
    })

    await t.step('Notes kept', () => {
        assert('notes' in res)
    })
})

Deno.test('20.4.2-default', async (t) => {
    const text = Deno.readTextFileSync('./tests/configs/20.4.2-default.json')
    const old = JSON.parse(text)
    const res = filterData('import', defaults, old)

    await t.step('Keep default link groups', () => {
        assert(JSON.stringify(res.links.folders.map((group) => group.id)) === `["default"]`)
    })

    await t.step('Removed widgets', () => {
        assert('main' in res === false)
        assert('weather' in res === false)
        assert('searchbar' in res === false)
        assert('quotes' in res === false)
    })

    await t.step('Notes kept', () => {
        assert('notes' in res)
    })
})

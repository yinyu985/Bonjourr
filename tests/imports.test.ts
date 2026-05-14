import './init.test.ts'

// Import script after test init, document needs to be loaded first
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import { mergeImportedConfig } from '../src/scripts/compatibility/apply.ts'
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

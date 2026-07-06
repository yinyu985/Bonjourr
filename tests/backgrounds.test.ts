import './init.test.ts'

import { assertEquals } from '@std/assert'
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import {
    backgroundSourcePatch,
    mergeBackgroundPatch,
    queryCollectionName,
} from '../src/scripts/features/backgrounds/query.ts'

Deno.test('background search form selects the search provider', () => {
    const backgrounds = structuredClone(SYNC_DEFAULT.backgrounds)
    backgrounds.type = 'images'
    backgrounds.images = 'bonjourr-images-daylight'

    assertEquals(queryCollectionName('f_background-user-search', backgrounds), 'unsplash-images-search')
    assertEquals(queryCollectionName('i_background-user-search', backgrounds), 'unsplash-images-search')
})

Deno.test('background collection form selects the collection provider', () => {
    const backgrounds = structuredClone(SYNC_DEFAULT.backgrounds)
    backgrounds.type = 'images'
    backgrounds.images = 'bonjourr-images-daylight'

    assertEquals(queryCollectionName('f_background-user-coll', backgrounds), 'unsplash-images-collections')
    assertEquals(queryCollectionName('i_background-user-coll', backgrounds), 'unsplash-images-collections')
})

Deno.test('unknown background query form falls back to the selected provider', () => {
    const backgrounds = structuredClone(SYNC_DEFAULT.backgrounds)
    backgrounds.type = 'images'
    backgrounds.images = 'unsplash-images-search'

    assertEquals(queryCollectionName('custom-form', backgrounds), 'unsplash-images-search')
})

Deno.test('background texture patch preserves the current query', () => {
    const backgrounds = structuredClone(SYNC_DEFAULT.backgrounds)
    backgrounds.type = 'images'
    backgrounds.images = 'unsplash-images-search'
    backgrounds.query = 'nature'

    const next = mergeBackgroundPatch(backgrounds, { texture: { type: 'none' } })

    assertEquals(next.images, 'unsplash-images-search')
    assertEquals(next.query, 'nature')
    assertEquals(next.texture.type, 'none')
})

Deno.test('background provider patch preserves the current query when asked', () => {
    const backgrounds = structuredClone(SYNC_DEFAULT.backgrounds)
    backgrounds.type = 'images'
    backgrounds.images = 'bonjourr-images-daylight'
    backgrounds.query = 'nature'

    const next = mergeBackgroundPatch(backgrounds, backgroundSourcePatch('images', 'unsplash-images-search'))

    assertEquals(next.images, 'unsplash-images-search')
    assertEquals(next.query, 'nature')
})

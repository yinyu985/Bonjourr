import './init.test.ts'

import { assert, assertEquals } from '@std/assert'
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import { mergeSyncAppend } from '../src/scripts/features/synchronization/merge.ts'
import { isElem, isLink } from '../src/scripts/features/links/helpers.ts'

import type { LinkElem } from '../src/types/shared.ts'

const FAVORITES_GROUP = '__favorites'

Deno.test({
    name: 'merge keeps incoming browser bookmarks as a local fallback',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const current = structuredClone(SYNC_DEFAULT)
        const incoming = structuredClone(SYNC_DEFAULT)

        incoming.linkgroups.groups = ['default', 'Work']
        incoming.linkgroups.synced = ['Work']
        incoming.linkgroups.bookmarkFolders = {
            [FAVORITES_GROUP]: 'toolbar',
            Work: 'folder-work',
        }
        incoming.linksRemote01 = bookmarkLink(
            'linksRemote01',
            'Work',
            'Remote work',
            'https://example.com/work',
            'bm-work',
        )
        incoming.linksRemote02 = bookmarkLink(
            'linksRemote02',
            FAVORITES_GROUP,
            'Remote favorite',
            'https://example.com/favorite',
            'bm-favorite',
        )

        const merged = mergeSyncAppend(current, incoming)
        const links = Object.values(merged).filter((value) => isLink(value) && isElem(value)) as LinkElem[]

        assert(merged.linkgroups.groups.includes('Work'))
        assert(!merged.linkgroups.groups.includes(FAVORITES_GROUP))
        assertEquals(merged.linkgroups.synced, [])
        assert(
            links.some((link) => link.parent === 'Work' && link.url === 'https://example.com/work' && !link.bookmark),
        )
        assert(
            links.some((link) =>
                link.parent === FAVORITES_GROUP && link.url === 'https://example.com/favorite' && !link.bookmark
            ),
        )
    },
})

Deno.test({
    name: 'merge deduplicates links within the same group only',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const current = structuredClone(SYNC_DEFAULT)
        const incoming = structuredClone(SYNC_DEFAULT)

        current.linkgroups.groups = ['Work', 'Personal']
        current.linksCurrent01 = plainLink('linksCurrent01', 'Work', 'Docs', 'https://example.com/docs')
        current.linksCurrent02 = plainLink('linksCurrent02', 'Personal', 'Docs', 'https://example.com/docs')

        incoming.linkgroups.groups = ['Work', 'Personal']
        incoming.linksIncoming01 = plainLink('linksIncoming01', 'Work', 'Docs copy', 'https://example.com/docs')
        incoming.linksIncoming02 = plainLink('linksIncoming02', 'Personal', 'Docs copy', 'https://example.com/docs')

        const merged = mergeSyncAppend(current, incoming)
        const links = Object.values(merged).filter((value) => isLink(value) && isElem(value)) as LinkElem[]
        const workLinks = links.filter((link) => link.parent === 'Work' && link.url === 'https://example.com/docs')
        const personalLinks = links.filter((link) =>
            link.parent === 'Personal' && link.url === 'https://example.com/docs'
        )

        assertEquals(workLinks.length, 1)
        assertEquals(personalLinks.length, 1)
    },
})

function bookmarkLink(_id: string, parent: string, title: string, url: string, bookmarkId: string): LinkElem {
    return {
        _id,
        parent,
        order: 0,
        title,
        url,
        bookmark: {
            id: bookmarkId,
            parentId: parent === FAVORITES_GROUP ? 'toolbar' : 'folder-work',
        },
    } satisfies LinkElem
}

function plainLink(_id: string, parent: string, title: string, url: string): LinkElem {
    return {
        _id,
        parent,
        order: 0,
        title,
        url,
    } satisfies LinkElem
}

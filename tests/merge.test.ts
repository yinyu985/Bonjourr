import './init.test.ts'

import { assert, assertEquals } from '@std/assert'
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import { allLinks, getSubfolder, isElem, removeNode } from '../src/scripts/features/links/model.ts'
import { mergeSyncAppend } from '../src/scripts/features/synchronization/merge.ts'

import type { LinkElem, LinkNode, LinkSubfolder } from '../src/types/shared.ts'
import type { LinkFolder } from '../src/types/sync.ts'

Deno.test({
    name: 'merge keeps incoming browser bookmarks as a local fallback',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const current = structuredClone(SYNC_DEFAULT)
        const incoming = structuredClone(SYNC_DEFAULT)

        incoming.links.folders.push({
            id: 'work',
            title: 'Work',
            pinned: false,
            source: 'bookmarks',
            items: [
                bookmarkLink('Remote work', 'https://example.com/work', 'bm-work'),
            ],
        })
        incoming.links.favorites.push(bookmarkLink('Remote favorite', 'https://example.com/favorite', 'bm-favorite'))

        const merged = mergeSyncAppend(current, incoming)
        const work = merged.links.folders.find((group) => group.id === 'work')

        assert(work)
        assertEquals(work.source, 'local')
        assert(
            work.items.some((link) => isElem(link) && link.url === 'https://example.com/work' && link.id !== 'bm-work'),
        )
        assert(
            merged.links.favorites.some((link) =>
                link.url === 'https://example.com/favorite' && link.id !== 'bm-favorite'
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

        current.links.folders = [
            group('work', 'Work', [plainLink('Docs', 'https://example.com/docs')]),
            group('personal', 'Personal', [plainLink('Docs', 'https://example.com/docs')]),
        ]
        incoming.links.folders = [
            group('work', 'Work', [plainLink('Docs copy', 'https://example.com/docs')]),
            group('personal', 'Personal', [plainLink('Docs copy', 'https://example.com/docs')]),
        ]

        const merged = mergeSyncAppend(current, incoming)
        const work = merged.links.folders.find((group) => group.id === 'work')?.items ?? []
        const personal = merged.links.folders.find((group) => group.id === 'personal')?.items ?? []

        assertEquals(work.filter((link) => isElem(link) && link.url === 'https://example.com/docs').length, 1)
        assertEquals(
            personal.filter((link) => isElem(link) && link.url === 'https://example.com/docs').length,
            1,
        )
    },
})

Deno.test({
    name: 'merge combines same-title subfolders and localizes bookmark ids',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const current = structuredClone(SYNC_DEFAULT)
        const incoming = structuredClone(SYNC_DEFAULT)

        current.links.folders = [
            group('work', 'Work', [
                subfolder('docs-local', 'Docs', [
                    plainLink('Design', 'https://example.com/design'),
                ]),
            ]),
        ]
        incoming.links.folders = [
            group('work', 'Work', [
                subfolder('docs-remote', 'Docs', [
                    bookmarkLink('Design copy', 'https://example.com/design', 'bm-design'),
                    bookmarkLink('Spec', 'https://example.com/spec', 'bm-spec'),
                ]),
            ]),
        ]

        const merged = mergeSyncAppend(current, incoming)
        const docs = getSubfolder(merged, 'docs-local')

        assert(docs)
        assertEquals(docs.items.filter((link) => link.url === 'https://example.com/design').length, 1)
        assert(docs.items.some((link) => link.url === 'https://example.com/spec' && link.id !== 'bm-spec'))
    },
})

Deno.test({
    name: 'model helpers find and remove nested subfolder links',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const data = structuredClone(SYNC_DEFAULT)

        data.links.folders = [
            group('work', 'Work', [
                plainLink('Top level', 'https://example.com/top'),
                subfolder('docs', 'Docs', [
                    plainLink('Nested', 'https://example.com/nested'),
                ]),
            ]),
        ]

        const nested = getSubfolder(data, 'docs')?.items[0]

        assert(nested)
        assertEquals(allLinks(data).length, 2)
        assertEquals(removeNode(data, nested.id), nested)
        assertEquals(getSubfolder(data, 'docs')?.items.length, 0)
        assertEquals(allLinks(data).length, 1)
    },
})

function group(id: string, title: string, items: LinkNode[]): LinkFolder {
    return {
        id,
        title,
        pinned: false,
        source: 'local',
        items,
    }
}

function bookmarkLink(title: string, url: string, id: string): LinkElem {
    return {
        id,
        title,
        url,
    }
}

function plainLink(title: string, url: string): LinkElem {
    return {
        id: `links${title.replaceAll(' ', '')}`,
        title,
        url,
    }
}

function subfolder(id: string, title: string, items: LinkElem[]): LinkSubfolder {
    return {
        id,
        title,
        items,
    }
}

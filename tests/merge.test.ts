import './init.test.ts'

import { assert, assertEquals } from '@std/assert'
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import { orderBookmarkToolbarChildren } from '../src/scripts/features/links/bookmark-order.ts'
import { allLinks, getSubfolder, isElem, removeNode } from '../src/scripts/features/links/model.ts'
import { computeDownloadedSync } from '../src/scripts/features/synchronization/merge.ts'

import type { LinkElem, LinkNode, LinkSubfolder } from '../src/types/shared.ts'
import type { LinkFolder } from '../src/types/sync.ts'

Deno.test({
    name: 'bookmark toolbar ordering keeps folders before direct bookmarks',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const children = [
            { id: 'direct-a', index: 0 },
            { id: 'folder-a', index: 1, children: [] },
            { id: 'direct-b', index: 2 },
            { id: 'folder-b', index: 3, children: [] },
        ]

        const orderedIds = orderBookmarkToolbarChildren(children).map((child) => child.id)

        assertEquals(orderedIds, ['folder-a', 'folder-b', 'direct-a', 'direct-b'])
    },
})

Deno.test({
    name: 'bookmark toolbar ordering keeps relative order within each section',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const children = [
            { id: 'direct-a', index: 0 },
            { id: 'folder-a', index: 1, children: [] },
            { id: 'folder-b', index: 2, children: [] },
            { id: 'direct-b', index: 3 },
        ]

        const orderedIds = orderBookmarkToolbarChildren(children).map((child) => child.id)
        const originalIds = children.map((child) => child.id)

        assertEquals(orderedIds, ['folder-a', 'folder-b', 'direct-a', 'direct-b'])
        assertEquals(originalIds, ['direct-a', 'folder-a', 'folder-b', 'direct-b'])
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

Deno.test({
    name: 'downloaded sync drops links that the remote no longer contains',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const incoming = structuredClone(SYNC_DEFAULT)

        // Local had two folders with their own links. Remote (incoming) only has Work.
        // After download we expect Personal — and its link — to be gone.
        incoming.links.folders = [
            group('work', 'Work', [plainLink('Docs', 'https://example.com/docs')]),
        ]

        const next = computeDownloadedSync(incoming)

        assertEquals(next.links.folders.map((folder) => folder.id), ['work'])
        assert(
            !allLinks(next).some((link) => link.url === 'https://example.com/personal'),
            'remote-deleted link must not survive the download',
        )
    },
})

Deno.test({
    name: 'downloaded sync removes a single deleted link from a kept folder',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const incoming = structuredClone(SYNC_DEFAULT)

        // The user kept 'Work' but deleted 'Spec' from it on another device.
        incoming.links.folders = [
            group('work', 'Work', [plainLink('Docs', 'https://example.com/docs')]),
        ]

        const next = computeDownloadedSync(incoming)
        const work = next.links.folders.find((folder) => folder.id === 'work')

        assert(work)
        assertEquals(work.items.length, 1)
        assert(!work.items.some((item) => isElem(item) && item.url === 'https://example.com/spec'))
    },
})

Deno.test({
    name: 'downloaded sync preserves duplicate URLs verbatim (no dedupe)',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        // Remote is the source of truth on download. If the remote stored two
        // identical URLs in the same folder (because that's what the user's
        // Chrome had), they must round-trip back unchanged — we are not
        // allowed to silently dedupe here.
        const incoming = structuredClone(SYNC_DEFAULT)
        incoming.links.folders = [
            group('work', 'Work', [
                plainLink('Docs', 'https://example.com/docs'),
                plainLink('Docs again', 'https://example.com/docs'),
            ]),
        ]

        const next = computeDownloadedSync(incoming)
        const work = next.links.folders.find((folder) => folder.id === 'work')

        assert(work)
        assertEquals(
            work.items.filter((item) => isElem(item) && item.url === 'https://example.com/docs').length,
            2,
            'download must not collapse duplicates — Remote is the source of truth',
        )
    },
})

function group(id: string, title: string, items: LinkNode[]): LinkFolder {
    return {
        id,
        title,
        items,
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

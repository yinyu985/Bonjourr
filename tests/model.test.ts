import './init.test.ts'

import { assert, assertEquals } from '@std/assert'
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import {
    allLinks,
    allNodes,
    createLink,
    createSubfolder,
    findNode,
    getFolder,
    getLink,
    getNode,
    getSubfolder,
    isElem,
    isLink,
    isSubfolder,
    newFolderId,
    newLinkId,
    normalizeLinksState,
    removeFolder,
    removeNode,
} from '../src/scripts/features/links/model.ts'

import type { LinkElem, LinkSubfolder } from '../src/types/shared.ts'
import type { LinkFolder, Sync } from '../src/types/sync.ts'

function makeSyncWithFolders(folders: LinkFolder[]): Sync {
    const data = structuredClone(SYNC_DEFAULT)
    data.links.folders = folders
    return data
}

function makeLink(id: string, title: string, url: string): LinkElem {
    return { id, title, url }
}

function makeSubfolder(id: string, title: string, items: LinkElem[]): LinkSubfolder {
    return { id, title, items }
}

function makeFolder(id: string, title: string, items: (LinkElem | LinkSubfolder)[]): LinkFolder {
    return { id, title, items }
}

// Type guards

Deno.test('isElem identifies link elements', () => {
    assert(isElem({ id: 'a', title: 'A', url: 'https://a.com' }))
    assert(!isElem({ id: 'b', title: 'B', items: [] }))
    assert(!isElem(undefined))
    assert(!isElem(null))
})

Deno.test('isSubfolder identifies subfolders', () => {
    assert(isSubfolder({ id: 'a', title: 'A', items: [] }))
    assert(!isSubfolder({ id: 'b', title: 'B', url: 'https://b.com' }))
    assert(!isSubfolder(undefined))
})

Deno.test('isLink identifies both types', () => {
    assert(isLink({ id: 'a', title: 'A', url: 'https://a.com' }))
    assert(isLink({ id: 'b', title: 'B', items: [] }))
    assert(!isLink(undefined))
})

// ID generation

Deno.test('newLinkId generates unique ids with links prefix', () => {
    const id1 = newLinkId()
    const id2 = newLinkId()
    assert(id1.startsWith('links'))
    assert(id2.startsWith('links'))
    assert(id1 !== id2)
})

Deno.test('newFolderId generates unique ids with folder prefix', () => {
    const id1 = newFolderId()
    const id2 = newFolderId()
    assert(id1.startsWith('folder'))
    assert(id2.startsWith('folder'))
    assert(id1 !== id2)
})

// createLink / createSubfolder

Deno.test('createLink uses provided id or generates one', () => {
    const withId = createLink('Test', 'https://test.com', 'custom-id')
    assertEquals(withId.id, 'custom-id')
    assertEquals(withId.title, 'Test')
    assertEquals(withId.url, 'https://test.com')

    const withoutId = createLink('Auto', 'https://auto.com')
    assert(withoutId.id.startsWith('links'))
})

Deno.test('createLink truncates long titles', () => {
    const longTitle = 'a'.repeat(100)
    const link = createLink(longTitle, 'https://long.com')
    assertEquals(link.title.length, 64)
})

Deno.test('createSubfolder creates with items', () => {
    const items = [makeLink('l1', 'L1', 'https://l1.com')]
    const sub = createSubfolder('My Folder', items)
    assert(sub.id.startsWith('links'))
    assertEquals(sub.title, 'My Folder')
    assertEquals(sub.items.length, 1)
})

// getFolder / getNode / getLink / getSubfolder

Deno.test('getFolder finds folder by id', () => {
    const data = makeSyncWithFolders([
        makeFolder('f1', 'First', []),
        makeFolder('f2', 'Second', []),
    ])

    assertEquals(getFolder(data, 'f1')?.title, 'First')
    assertEquals(getFolder(data, 'f2')?.title, 'Second')
    assertEquals(getFolder(data, 'f3'), undefined)
})

Deno.test('getNode finds top-level links', () => {
    const link = makeLink('link1', 'Link', 'https://link.com')
    const data = makeSyncWithFolders([makeFolder('f1', 'F', [link])])

    assertEquals(getNode(data, 'link1'), link)
})

Deno.test('getNode finds links inside subfolders', () => {
    const nested = makeLink('nested1', 'Nested', 'https://nested.com')
    const sub = makeSubfolder('sub1', 'Sub', [nested])
    const data = makeSyncWithFolders([makeFolder('f1', 'F', [sub])])

    assertEquals(getNode(data, 'nested1'), nested)
    assertEquals(getNode(data, 'sub1'), sub)
})

Deno.test('getLink returns undefined for subfolders', () => {
    const sub = makeSubfolder('sub1', 'Sub', [])
    const data = makeSyncWithFolders([makeFolder('f1', 'F', [sub])])

    assertEquals(getLink(data, 'sub1'), undefined)
})

Deno.test('getSubfolder returns undefined for links', () => {
    const link = makeLink('link1', 'Link', 'https://link.com')
    const data = makeSyncWithFolders([makeFolder('f1', 'F', [link])])

    assertEquals(getSubfolder(data, 'link1'), undefined)
})

// findNode with location info

Deno.test('findNode returns location with index', () => {
    const link1 = makeLink('l1', 'L1', 'https://l1.com')
    const link2 = makeLink('l2', 'L2', 'https://l2.com')
    const folder = makeFolder('f1', 'F', [link1, link2])
    const data = makeSyncWithFolders([folder])

    const location = findNode(data, 'l2')
    assert(location)
    assertEquals(location.index, 1)
    assertEquals(location.folder.id, 'f1')
})

Deno.test('findNode finds favorites', () => {
    const data = structuredClone(SYNC_DEFAULT)
    data.links.favorites = [makeLink('fav1', 'Fav', 'https://fav.com')]

    const location = findNode(data, 'fav1')
    assert(location)
    assertEquals(location.folder.id, '__favorites')
})

// removeNode

Deno.test('removeNode removes and returns the node', () => {
    const link = makeLink('l1', 'L1', 'https://l1.com')
    const data = makeSyncWithFolders([makeFolder('f1', 'F', [link])])

    const removed = removeNode(data, 'l1')
    assertEquals(removed, link)
    assertEquals(data.links.folders[0].items.length, 0)
})

Deno.test('removeNode removes nested link from subfolder', () => {
    const nested = makeLink('n1', 'Nested', 'https://n.com')
    const sub = makeSubfolder('s1', 'Sub', [nested])
    const data = makeSyncWithFolders([makeFolder('f1', 'F', [sub])])

    const removed = removeNode(data, 'n1')
    assertEquals(removed, nested)
    assertEquals(getSubfolder(data, 's1')?.items.length, 0)
})

Deno.test('removeNode returns undefined for non-existent id', () => {
    const data = makeSyncWithFolders([makeFolder('f1', 'F', [])])
    assertEquals(removeNode(data, 'nope'), undefined)
})

// removeFolder

Deno.test('removeFolder removes folder and updates selectedFolder', () => {
    const data = makeSyncWithFolders([
        makeFolder('f1', 'First', []),
        makeFolder('f2', 'Second', []),
    ])
    data.links.selectedFolder = 'f1'

    const removed = removeFolder(data, 'f1')
    assertEquals(removed?.id, 'f1')
    assertEquals(data.links.folders.length, 1)
    assertEquals(data.links.selectedFolder, 'f2')
})

// allLinks / allNodes

Deno.test('allLinks flattens links from all folders and subfolders', () => {
    const l1 = makeLink('l1', 'L1', 'https://l1.com')
    const l2 = makeLink('l2', 'L2', 'https://l2.com')
    const l3 = makeLink('l3', 'L3', 'https://l3.com')
    const sub = makeSubfolder('s1', 'Sub', [l2])
    const data = makeSyncWithFolders([makeFolder('f1', 'F', [l1, sub])])
    data.links.favorites = [l3]

    assertEquals(allLinks(data).length, 3)
    assertEquals(allNodes(data).length, 4) // includes subfolder itself
})

// normalizeLinksState

Deno.test('normalizeLinksState creates default folder if empty', () => {
    const data: Partial<Sync> = {
        links: {
            enabled: true,
            foldersOn: false,
            selectedFolder: 'default',
            rows: 16,
            iconRadius: 0,
            style: 'text',
            newTab: true,
            titles: false,
            backgrounds: true,
            folders: [],
            favorites: [],
        },
    }
    const links = normalizeLinksState(data)

    assertEquals(links.folders.length, 1)
    assertEquals(links.folders[0].title, 'default')
})

Deno.test('normalizeLinksState fixes invalid selectedFolder', () => {
    const data: Partial<Sync> = {
        links: {
            enabled: true,
            foldersOn: false,
            selectedFolder: 'non-existent',
            rows: 16,
            iconRadius: 0,
            style: 'text',
            newTab: true,
            titles: false,
            backgrounds: true,
            folders: [makeFolder('actual', 'Actual', [])],
            favorites: [],
        },
    }
    const links = normalizeLinksState(data)
    assertEquals(links.selectedFolder, 'actual')
})

Deno.test('normalizeLinksState filters invalid items from folders', () => {
    const items = [
        makeLink('valid', 'Valid', 'https://v.com'),
        null,
        undefined,
        { broken: true },
    ]

    const data: Partial<Sync> = {
        links: {
            enabled: true,
            foldersOn: false,
            selectedFolder: 'f1',
            rows: 16,
            iconRadius: 0,
            style: 'text',
            newTab: true,
            titles: false,
            backgrounds: true,
            folders: [{
                id: 'f1',
                title: 'F',
                // deno-lint-ignore no-explicit-any
                items: items as any,
            }],
            favorites: [],
        },
    }
    const links = normalizeLinksState(data)
    assertEquals(links.folders[0].items.length, 1)
})

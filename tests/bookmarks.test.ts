import './init.test.ts'

import { assertEquals, assertRejects, assertThrows } from '@std/assert'
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import {
    __testing as bookmarkTesting,
    BookmarkAccessError,
    buildBookmarkSnapshotFromConfig,
    findBookmarksToolbar,
    initBookmarkSync,
    replaceBookmarksFromConfig,
} from '../src/scripts/features/links/bookmarks.ts'
import { syncWithBookmarks } from '../src/scripts/features/links/model.ts'

import type { LinkNode } from '../src/types/shared.ts'
import type { LinkFolder, SyncSnapshot } from '../src/types/sync.ts'

type Treenode = chrome.bookmarks.BookmarkTreeNode
type EventListener = (...args: unknown[]) => void

type MemoryBookmarks = {
    api: typeof chrome.bookmarks
    listenerCount: (event: string) => number
}

Deno.test({
    name: 'bookmark toolbar lookup prefers folderType and fails closed when the root is ambiguous',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const typed = rootTree([
            folder('menu', 'Bookmarks menu', []),
            { ...folder('bar', 'Bookmarks bar', []), folderType: 'bookmarks-bar' } as Treenode,
        ])
        assertEquals(findBookmarksToolbar(typed).id, 'bar')

        const legacy = rootTree([folder('2', 'Other', []), folder('1', 'Bar', [])])
        assertEquals(findBookmarksToolbar(legacy).id, '1')

        const ambiguous = rootTree([folder('menu', 'Menu', []), folder('other', 'Other', [])])
        assertThrows(() => findBookmarksToolbar(ambiguous), BookmarkAccessError)
    },
})

Deno.test({
    name: 'upload snapshot refuses startup cache when live bookmarks are unavailable',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        globalThis.startupBookmarks = rootTree([folder('1', 'Cached bar', [])])
        bookmarkTesting.setBookmarksApi(null)

        try {
            await assertRejects(
                () => buildBookmarkSnapshotFromConfig(structuredClone(SYNC_DEFAULT)),
                BookmarkAccessError,
                'unavailable',
            )
        } finally {
            globalThis.startupBookmarks = undefined
            bookmarkTesting.reset()
        }
    },
})

Deno.test({
    name: 'live snapshot preserves duplicate folder names, reserved-looking names, order, URLs, and long titles',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const longTitle = 'A'.repeat(140)
        const tree = rootTree([
            toolbar([
                bookmark('favorite', longTitle, 'mailto:test@example.com'),
                folder('first', 'Same', [
                    bookmark('file', '', 'file:///Users/example/file.txt'),
                    folder('nested-1', 'Nested', [bookmark('js', 'Script', 'javascript:void(0)')]),
                    folder('nested-2', 'Nested', [bookmark('custom', 'Custom', 'web+bonjourr:open')]),
                ]),
                folder('second', 'Same', [bookmark('second-link', 'Second', 'https://second.example/path')]),
                folder('reserved', '__favorites', [bookmark('reserved-link', 'Kept', 'https://kept.example')]),
            ]),
        ])
        const memory = memoryBookmarks(tree)
        bookmarkTesting.setBookmarksApi(memory.api)

        try {
            const snapshot = await buildBookmarkSnapshotFromConfig(structuredClone(SYNC_DEFAULT))

            assertEquals(snapshot.links.folders.map((item) => item.title), ['Same', 'Same', '__favorites'])
            assertEquals(snapshot.links.folders[0].items.map((item) => item.title), ['', 'Nested', 'Nested'])
            assertEquals(snapshot.links.folders[0].items[0], {
                id: 'file',
                title: '',
                url: 'file:///Users/example/file.txt',
            })
            assertEquals(snapshot.links.favorites[0].title, longTitle)
            assertEquals(snapshot.links.favorites[0].url, 'mailto:test@example.com')
            assertEquals(snapshot.links.toolbarOrder, ['favorite', 'first', 'second', 'reserved'])
        } finally {
            bookmarkTesting.reset()
        }
    },
})

Deno.test({
    name: 'restore preserves folders and direct bookmarks interleaved at the toolbar',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const memory = memoryBookmarks(rootTree([toolbar([])]))
        bookmarkTesting.setBookmarksApi(memory.api)
        const next = bookmarkSnapshot(
            [
                { id: 'folder-a', title: 'Folder A', items: [] },
                { id: 'folder-b', title: 'Folder B', items: [] },
            ],
            [
                { id: 'favorite-a', title: 'Favorite A', url: 'https://a.example' },
                { id: 'favorite-b', title: 'Favorite B', url: 'https://b.example' },
            ],
        )
        next.links.toolbarOrder = ['folder-a', 'favorite-a', 'folder-b', 'favorite-b']

        try {
            await replaceBookmarksFromConfig(structuredClone(SYNC_DEFAULT), next)
            const snapshot = await buildBookmarkSnapshotFromConfig(structuredClone(SYNC_DEFAULT))
            const labels = new Map([
                ...snapshot.links.folders.map((folder) => [folder.id, folder.title] as const),
                ...snapshot.links.favorites.map((favorite) => [favorite.id, favorite.title] as const),
            ])
            assertEquals(snapshot.links.toolbarOrder?.map((id) => labels.get(id)), [
                'Folder A',
                'Favorite A',
                'Folder B',
                'Favorite B',
            ])
        } finally {
            bookmarkTesting.reset()
        }
    },
})

Deno.test({
    name: 'restore keeps duplicate folders separate, deletes empty favorites, and restores nested order exactly',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const memory = memoryBookmarks(rootTree([
            toolbar([
                bookmark('old-favorite', 'Remove me', 'https://old.example'),
                folder('local-first', 'Same', [bookmark('old-a', 'Old A', 'https://old-a.example')]),
                folder('local-second', 'Same', [bookmark('old-b', 'Old B', 'https://old-b.example')]),
                folder('local-reserved', '__favorites', []),
            ]),
        ]))
        bookmarkTesting.setBookmarksApi(memory.api)
        const next = bookmarkSnapshot([
            {
                id: 'remote-first',
                title: 'Same',
                items: [
                    link('mail', 'M'.repeat(100), 'mailto:user@example.com'),
                    subfolder('nested-a', 'Nested', [link('file', 'File', 'file:///tmp/a')]),
                    link('custom', 'Custom', 'web+bonjourr:open'),
                    subfolder('nested-b', 'Nested', [link('js', 'JS', 'javascript:void(0)')]),
                ],
            },
            {
                id: 'remote-second',
                title: 'Same',
                items: [link('second', 'Second', 'https://second.example/path')],
            },
            {
                id: 'remote-reserved',
                title: '__favorites',
                items: [link('kept', 'Kept', 'https://kept.example')],
            },
        ], [])

        try {
            assertEquals(await replaceBookmarksFromConfig(structuredClone(SYNC_DEFAULT), next), true)
            const restored = await buildBookmarkSnapshotFromConfig(structuredClone(SYNC_DEFAULT))

            assertEquals(restored.links.favorites, [])
            assertEquals(restored.links.folders.map((item) => item.title), ['Same', 'Same', '__favorites'])
            assertEquals(restored.links.folders[0].items.map((item) => item.title), [
                'M'.repeat(100),
                'Nested',
                'Custom',
                'Nested',
            ])
            assertEquals(restored.links.folders[0].items.map(nodeKind), [
                'bookmark',
                'folder',
                'bookmark',
                'folder',
            ])
            assertEquals(restored.links.folders[1].items[0].title, 'Second')
            assertEquals((restored.links.folders[1].items[0] as { url: string }).url, 'https://second.example/path')
        } finally {
            bookmarkTesting.reset()
        }
    },
})

Deno.test({
    name: 'restore propagates a Chrome write failure instead of reporting success',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const memory = memoryBookmarks(
            rootTree([toolbar([folder('local', 'Folder', [bookmark('item', 'Old', 'https://same.example')])])]),
            'update',
        )
        bookmarkTesting.setBookmarksApi(memory.api)
        const next = bookmarkSnapshot([
            { id: 'remote', title: 'Folder', items: [link('remote-item', 'New', 'https://same.example')] },
        ], [])

        try {
            await assertRejects(
                () => replaceBookmarksFromConfig(structuredClone(SYNC_DEFAULT), next),
                Error,
                'injected update failure',
            )
        } finally {
            bookmarkTesting.reset()
        }
    },
})

Deno.test({
    name: 'bookmark listeners include child reordering events',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const memory = memoryBookmarks(rootTree([toolbar([])]))
        bookmarkTesting.setBookmarksApi(memory.api)

        try {
            await initBookmarkSync(structuredClone(SYNC_DEFAULT))
            assertEquals(memory.listenerCount('onChildrenReordered'), 1)
        } finally {
            bookmarkTesting.reset()
        }
    },
})

function bookmarkSnapshot(folders: LinkFolder[], favorites: SyncSnapshot['links']['favorites']): SyncSnapshot {
    const snapshot = syncWithBookmarks(structuredClone(SYNC_DEFAULT))
    snapshot.links.folders = folders
    snapshot.links.favorites = favorites
    snapshot.links.selectedFolder = folders[0]?.id ?? ''
    return snapshot
}

function link(id: string, title: string, url: string): LinkNode {
    return { id, title, url }
}

function subfolder(id: string, title: string, items: LinkNode[]): LinkNode {
    return { id, title, items }
}

function nodeKind(node: LinkNode): string {
    return 'url' in node ? 'bookmark' : 'folder'
}

function rootTree(children: Treenode[]): Treenode[] {
    return [folder('0', '', children)]
}

function toolbar(children: Treenode[]): Treenode {
    return { ...folder('1', 'Bookmarks bar', children), folderType: 'bookmarks-bar' } as Treenode
}

function folder(id: string, title: string, children: Treenode[]): Treenode {
    return { id, title, children, syncing: false }
}

function bookmark(id: string, title: string, url: string): Treenode {
    return { id, title, url, syncing: false }
}

function memoryBookmarks(initial: Treenode[], failOperation?: 'update'): MemoryBookmarks {
    const trees = structuredClone(initial)
    let nextId = 1000
    const listeners = new Map<string, EventListener[]>()

    function addEvent(name: string): { addListener: (listener: EventListener) => void } {
        return {
            addListener(listener: EventListener): void {
                const current = listeners.get(name) ?? []
                current.push(listener)
                listeners.set(name, current)
            },
        }
    }

    function findNode(id: string): Treenode | undefined {
        return flatten(trees).find((node) => node.id === id)
    }

    function detach(id: string): Treenode {
        for (const parent of flatten(trees)) {
            const index = parent.children?.findIndex((child) => child.id === id) ?? -1
            if (index >= 0) return parent.children!.splice(index, 1)[0]
        }
        throw new Error(`missing bookmark ${id}`)
    }

    function insert(parentId: string, node: Treenode, index?: number): void {
        const parent = findNode(parentId)
        if (!parent?.children) throw new Error(`missing parent ${parentId}`)
        node.parentId = parentId
        const target = Math.max(0, Math.min(index ?? parent.children.length, parent.children.length))
        parent.children.splice(target, 0, node)
        updateIndexes(parent)
    }

    const api = {
        getTree(): Promise<Treenode[]> {
            return Promise.resolve(structuredClone(trees))
        },
        create(details: chrome.bookmarks.CreateDetails): Promise<Treenode> {
            const node: Treenode = details.url
                ? { id: String(nextId++), title: details.title ?? '', url: details.url, syncing: false }
                : { id: String(nextId++), title: details.title ?? '', children: [], syncing: false }
            insert(details.parentId ?? '0', node, details.index)
            return Promise.resolve(structuredClone(node))
        },
        move(id: string, destination: chrome.bookmarks.MoveDestination): Promise<Treenode> {
            const node = detach(id)
            insert(destination.parentId ?? node.parentId ?? '0', node, destination.index)
            return Promise.resolve(structuredClone(node))
        },
        update(id: string, changes: chrome.bookmarks.UpdateChanges): Promise<Treenode> {
            if (failOperation === 'update') throw new Error('injected update failure')
            const node = findNode(id)
            if (!node) throw new Error(`missing bookmark ${id}`)
            if (changes.title !== undefined) node.title = changes.title
            if (changes.url !== undefined) node.url = changes.url
            return Promise.resolve(structuredClone(node))
        },
        remove(id: string): Promise<void> {
            detach(id)
            return Promise.resolve()
        },
        removeTree(id: string): Promise<void> {
            detach(id)
            return Promise.resolve()
        },
        onChanged: addEvent('onChanged'),
        onCreated: addEvent('onCreated'),
        onRemoved: addEvent('onRemoved'),
        onMoved: addEvent('onMoved'),
        onChildrenReordered: addEvent('onChildrenReordered'),
    } as unknown as typeof chrome.bookmarks

    return {
        api,
        listenerCount(event: string): number {
            return listeners.get(event)?.length ?? 0
        },
    }
}

function flatten(trees: Treenode[]): Treenode[] {
    const result: Treenode[] = []
    function walk(node: Treenode): void {
        result.push(node)
        for (const child of node.children ?? []) walk(child)
    }
    for (const tree of trees) walk(tree)
    return result
}

function updateIndexes(parent: Treenode): void {
    for (let index = 0; index < (parent.children?.length ?? 0); index++) {
        parent.children![index].index = index
        parent.children![index].parentId = parent.id
    }
}

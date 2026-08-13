type Treenode = chrome.bookmarks.BookmarkTreeNode

export function installDefaultBookmarkMock(): void {
    const globalWithChrome = globalThis as typeof globalThis & { chrome?: typeof chrome }
    if (globalWithChrome.chrome?.bookmarks) return

    let trees = emptyTree()
    let nextId = 1000
    const event = { addListener: (_listener: (...args: never[]) => void): void => {} }

    function currentTrees(): Treenode[] {
        return globalThis.startupBookmarks ?? trees
    }

    function findNode(id: string): Treenode | undefined {
        return flatten(currentTrees()).find((node) => node.id === id)
    }

    function detach(id: string): Treenode {
        for (const parent of flatten(trees)) {
            const index = parent.children?.findIndex((child) => child.id === id) ?? -1
            if (index >= 0) return parent.children!.splice(index, 1)[0]
        }
        throw new Error(`Missing test bookmark ${id}`)
    }

    function insert(parentId: string, node: Treenode, index?: number): void {
        const parent = flatten(trees).find((candidate) => candidate.id === parentId)
        if (!parent?.children) throw new Error(`Missing test bookmark parent ${parentId}`)
        node.parentId = parentId
        const target = Math.max(0, Math.min(index ?? parent.children.length, parent.children.length))
        parent.children.splice(target, 0, node)
        updateIndexes(parent)
    }

    const bookmarks = {
        getTree(): Promise<Treenode[]> {
            return Promise.resolve(structuredClone(currentTrees()))
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
            const node = findNode(id)
            if (!node) throw new Error(`Missing test bookmark ${id}`)
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
        onChanged: event,
        onCreated: event,
        onRemoved: event,
        onMoved: event,
        onChildrenReordered: event,
    } as unknown as typeof chrome.bookmarks

    Object.defineProperty(globalWithChrome, 'chrome', {
        configurable: true,
        writable: true,
        value: { bookmarks } as typeof chrome,
    })

    function resetTreeWhenStartupCacheClears(): void {
        if (globalThis.startupBookmarks) trees = structuredClone(globalThis.startupBookmarks)
    }

    globalThis.addEventListener('bonjourr-test-bookmarks-reset', resetTreeWhenStartupCacheClears)
}

function emptyTree(): Treenode[] {
    return [{
        id: '0',
        title: '',
        syncing: false,
        children: [{
            id: '1',
            title: 'Bookmarks bar',
            syncing: false,
            children: [],
        }],
    }]
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

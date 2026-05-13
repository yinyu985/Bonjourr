type BookmarkNode = Pick<browser.bookmarks.BookmarkTreeNode, 'children' | 'index'>

export function orderBookmarkToolbarChildren<T extends BookmarkNode>(children: T[]): T[] {
    const sorted = [...children].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const folders = sorted.filter((child) => Array.isArray(child.children))
    const directBookmarks = sorted.filter((child) => !Array.isArray(child.children))

    return [...folders, ...directBookmarks]
}

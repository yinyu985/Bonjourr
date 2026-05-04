globalThis.startupBookmarks
globalThis.startupStorage = {
    sync: undefined,
    local: undefined,
}

chrome.storage.local.get().then((data) => {
    globalThis.startupStorage.local = data
    globalThis.startupStorage.sync = data.syncStorage

    if (globalThis.pageReady) {
        document.dispatchEvent(
            new CustomEvent('webextstorage'),
        )
    }
})

chrome.bookmarks?.getTree().then((data) => {
    globalThis.startupBookmarks = data
})

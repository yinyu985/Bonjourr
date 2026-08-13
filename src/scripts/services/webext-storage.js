globalThis.startupBookmarks
globalThis.startupStorage = {
    sync: undefined,
    local: undefined,
}

const startupStorageKeys = [
    'syncStorage',
    'fonts',
    'fontface',
    'translations',
    'operaExplained',
    'gistToken',
    'unsplashAccessKey',
    'remoteResourceId',
    'remoteLastSyncedAt',
    'remoteLastFetchedAt',
    'localConfigUpdatedAt',
    'lastSyncedPayload',
    'syncType',
    'backgroundCollections',
    'backgroundUrls',
    'backgroundFiles',
    'backgroundLastChange',
    'backgroundLastTrackedPhoto',
    'backgroundCompressFiles',
]

chrome.storage.local.get(startupStorageKeys).then((data) => {
    globalThis.startupStorage.local = data
    globalThis.startupStorage.sync = data.syncStorage

    if (globalThis.pageReady) {
        document.dispatchEvent(
            new CustomEvent('webextstorage'),
        )
    }
}).catch((err) => console.warn('Cannot preload extension storage', err))

chrome.bookmarks?.getTree().then((data) => {
    globalThis.startupBookmarks = data
}).catch((err) => console.warn('Cannot preload bookmarks', err))

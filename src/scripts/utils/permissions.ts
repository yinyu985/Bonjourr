import { PLATFORM } from '../defaults.ts'

// Deduplicates concurrent permission requests for the same permissions.
// If getPermissions('bookmarks') is called while a previous call is already
// pending (e.g. from startup initBookmarkSync AND from the accept-permissions
// button at the same time), both callers share the same browser dialog instead
// of stacking two identical popups on top of each other.
const pendingRequests = new Map<string, Promise<boolean>>()

export function getPermissions(...args: string[]): Promise<boolean> {
    const key = args.join(',')

    const existing = pendingRequests.get(key)
    if (existing) {
        return existing
    }

    const promise = requestPermissions(args).finally(() => {
        pendingRequests.delete(key)
    })

    pendingRequests.set(key, promise)
    return promise
}

async function requestPermissions(args: string[]): Promise<boolean> {
    switch (PLATFORM) {
        case 'online': {
            return true
        }

        case 'firefox': {
            const hasPermission = await browser.permissions.contains({
                permissions: [...args as browser._manifest.OptionalPermission[]],
            })

            if (hasPermission) {
                return true
            }

            return await browser.permissions.request({
                permissions: [...args as browser._manifest.OptionalPermission[]],
            })
        }

        default: {
            const hasPermission = await chrome.permissions.contains({
                permissions: [...args as chrome.runtime.ManifestPermissions[]],
            })

            if (hasPermission) {
                return true
            }

            return chrome.permissions.request({
                permissions: [...args as chrome.runtime.ManifestPermissions[]],
            }) ?? false
        }
    }
}

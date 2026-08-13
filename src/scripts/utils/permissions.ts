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

/** Request only the HTTPS origin needed for a user-triggered remote download. */
export function requestHostPermission(url: URL): Promise<boolean> {
    if (url.protocol !== 'https:') {
        return Promise.resolve(false)
    }
    if (PLATFORM === 'online') {
        return Promise.resolve(true)
    }

    return chrome.permissions.request({ origins: [`${url.origin}/*`] })
}

async function requestPermissions(args: string[]): Promise<boolean> {
    if (PLATFORM === 'online') {
        return true
    }

    const permissions = [...args as chrome.runtime.ManifestPermissions[]]
    const hasPermission = await chrome.permissions.contains({ permissions })

    if (hasPermission) {
        return true
    }

    return chrome.permissions.request({ permissions }) ?? false
}

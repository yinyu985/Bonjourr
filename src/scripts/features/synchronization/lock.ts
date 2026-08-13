const REMOTE_LOCK_NAME = 'bonjourr-remote-sync'
const CONFIG_LOCK_NAME = 'bonjourr-config-storage'
const fallbackStates = new Map<string, { locked: boolean; waiters: Array<() => void> }>()

interface RemoteLockManager {
    request(
        name: string,
        callback: (lock: unknown) => Promise<void>,
    ): Promise<void>
    request(
        name: string,
        options: { ifAvailable: true },
        callback: (lock: unknown | null) => Promise<void>,
    ): Promise<void>
}

/** Serialize remote sync operations across every new-tab page. */
export async function acquireSynchronizationLock(wait = false): Promise<(() => void) | undefined> {
    return await acquireNamedLock(REMOTE_LOCK_NAME, wait)
}

export async function withCrossContextSynchronizationLock<T>(action: () => Promise<T>): Promise<T> {
    const release = await acquireSynchronizationLock()
    if (!release) throw new Error('Synchronization is already in progress in another tab')

    try {
        return await action()
    } finally {
        release()
    }
}

/** Serialize config reads/writes with destructive restores across all tabs. */
export async function withConfigStorageLock<T>(action: () => Promise<T>): Promise<T> {
    const release = await acquireNamedLock(CONFIG_LOCK_NAME, true)
    if (!release) throw new Error('Configuration storage lock is unavailable')

    try {
        return await action()
    } finally {
        release()
    }
}

async function acquireNamedLock(name: string, wait: boolean): Promise<(() => void) | undefined> {
    const manager = (globalThis.navigator as Navigator & { locks?: RemoteLockManager } | undefined)?.locks
    if (!manager) return await acquireFallbackLock(name, wait)

    return await new Promise((resolve) => {
        let resolved = false
        const callback = async (lock: unknown | null): Promise<void> => {
            if (!lock) {
                resolved = true
                resolve(undefined)
                return
            }

            await new Promise<void>((release) => {
                resolved = true
                resolve(release)
            })
        }
        const request = wait ? manager.request(name, callback) : manager.request(name, { ifAvailable: true }, callback)

        void request.catch((err) => {
            console.warn('Cross-context lock failed', err)
            if (!resolved) resolve(undefined)
        })
    })
}

async function acquireFallbackLock(name: string, wait: boolean): Promise<(() => void) | undefined> {
    const state = fallbackStates.get(name) ?? { locked: false, waiters: [] }
    fallbackStates.set(name, state)

    if (state.locked) {
        if (!wait) return
        await new Promise<void>((resolve) => state.waiters.push(resolve))
    }
    state.locked = true
    let released = false

    return () => {
        if (released) return
        released = true
        const next = state.waiters.shift()
        if (next) {
            next()
        } else {
            state.locked = false
        }
    }
}

import { storage } from '../storage.ts'

type AnyFunction = (...args: never[]) => unknown

interface DebounceControl {
    cancel: () => void
    flush: () => Promise<void>
    pending: () => boolean
}

interface DebounceOptions {
    barrier?: boolean
}

type Debounced<F extends AnyFunction> = {
    (...args: Parameters<F>): void
} & DebounceControl

const activeDebounces = new Set<DebounceControl>()

export function debounce<F extends AnyFunction>(
    callback: F,
    waitFor: number,
    options: DebounceOptions = {},
): Debounced<F> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let pendingArgs: Parameters<F> | undefined
    let currentExecution: Promise<void> | undefined

    const cleanup = (execution: Promise<void>): void => {
        if (currentExecution === execution) {
            currentExecution = undefined
        }
        if (options.barrier && !pendingArgs && !currentExecution) {
            activeDebounces.delete(debounced)
        }
    }

    const execute = (): Promise<void> => {
        if (!pendingArgs) {
            return currentExecution ?? Promise.resolve()
        }

        const args = pendingArgs
        pendingArgs = undefined
        if (timeout !== undefined) {
            clearTimeout(timeout)
            timeout = undefined
        }

        const previousExecution = currentExecution?.catch(() => {}) ?? Promise.resolve()
        const execution = previousExecution.then(async () => {
            await callback(...args)
        })

        currentExecution = execution
        void execution.then(
            () => cleanup(execution),
            (err) => {
                console.warn('[debounce] callback failed', err)
                cleanup(execution)
            },
        )

        return execution
    }

    const debounced = ((...args: Parameters<F>): void => {
        pendingArgs = args
        if (timeout !== undefined) {
            clearTimeout(timeout)
        }
        if (options.barrier) {
            activeDebounces.add(debounced)
        }
        timeout = setTimeout(() => {
            void execute().catch(() => {})
        }, waitFor)
    }) as Debounced<F>

    debounced.cancel = (): void => {
        if (timeout !== undefined) {
            clearTimeout(timeout)
            timeout = undefined
        }
        pendingArgs = undefined
        if (options.barrier && !currentExecution) {
            activeDebounces.delete(debounced)
        }
    }

    debounced.flush = execute
    debounced.pending = (): boolean => pendingArgs !== undefined

    return debounced
}

export async function flushPendingDebounces(): Promise<void> {
    const failures: unknown[] = []

    while (activeDebounces.size > 0) {
        const results = await Promise.allSettled([...activeDebounces].map((entry) => entry.flush()))
        failures.push(...results.filter((result) => result.status === 'rejected').map((result) => result.reason))
    }

    if (failures.length > 0) {
        throw new AggregateError(failures, 'One or more debounced operations failed')
    }
}

export function cancelPendingDebounces(): void {
    for (const entry of [...activeDebounces]) {
        entry.cancel()
    }
}

function flushBeforeSuspension(): void {
    void flushPendingDebounces().catch((err) => {
        console.warn('[debounce] cannot flush pending operations before page suspension', err)
    })
}

globalThis.addEventListener('pagehide', flushBeforeSuspension)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        flushBeforeSuspension()
    }
})

let pendingEventPatch: Record<string, unknown> = {}

const persistEventPatch = debounce(
    async (value: Record<string, unknown>) => {
        pendingEventPatch = {}
        await storage.sync.update((current) => {
            applyPatch(current, value)
        })
    },
    400,
    { barrier: true },
)

export const eventDebounce = Object.assign(
    (value: Record<string, unknown>): void => {
        if (!persistEventPatch.pending()) {
            pendingEventPatch = {}
        }

        pendingEventPatch = mergePatches(pendingEventPatch, value)
        persistEventPatch(structuredClone(pendingEventPatch))
    },
    {
        cancel: (): void => {
            pendingEventPatch = {}
            persistEventPatch.cancel()
        },
        flush: (): Promise<void> => persistEventPatch.flush(),
        pending: (): boolean => persistEventPatch.pending(),
    },
)

function mergePatches(current: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
    const merged = { ...current }

    for (const [key, value] of Object.entries(incoming)) {
        const previous = merged[key]
        const canMerge = isRecord(previous) && isRecord(value)
        merged[key] = canMerge ? { ...previous, ...value } : value
    }

    return merged
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function applyPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(patch)) {
        if (isRecord(target[key]) && isRecord(value)) {
            applyPatch(target[key] as Record<string, unknown>, value)
        } else {
            target[key] = structuredClone(value)
        }
    }
}

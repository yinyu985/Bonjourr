import { storage } from '../storage.ts'

import type { Hide } from '../../types/sync.ts'

export async function hideElements(hide?: Hide, options?: { isEvent: true }): Promise<void> {
    hide ??= {}

    if (options?.isEvent) {
        await storage.sync.update((sync) => {
            sync.hide = { ...sync.hide, ...hide }
        })
    }

    for (const [key, val] of Object.entries(hide)) {
        for (const element of document.querySelectorAll(`[data-hide="${key}"]`)) {
            element?.classList.toggle('he_hidden', val)
        }
    }
}

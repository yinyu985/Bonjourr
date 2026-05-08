import { ENVIRONNEMENT, PLATFORM } from '../defaults.ts'

export function serviceWorker(): void {
    if (ENVIRONNEMENT !== 'PROD' || PLATFORM !== 'online' || !('serviceWorker' in navigator)) {
        return
    }

    navigator.serviceWorker.register('./service-worker.js', { scope: './' }).catch((err) => {
        console.warn('Service worker registration failed', err)
    })
}

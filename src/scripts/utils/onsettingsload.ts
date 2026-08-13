type SettingsLoadCallback = () => void | Promise<void>

const callbackList: SettingsLoadCallback[] = []
let areSettingsLoaded = false

export function onSettingsLoad(callback: SettingsLoadCallback): void {
    if (areSettingsLoaded) {
        runCallback(callback)
    } else {
        callbackList.push(callback)
    }
}

export function loadCallbacks(): void {
    for (const callback of callbackList) {
        runCallback(callback)
    }

    callbackList.length = 0
    areSettingsLoaded = true
}

function runCallback(callback: SettingsLoadCallback): void {
    try {
        void Promise.resolve(callback()).catch((err) => {
            console.warn('Settings initialization callback failed', err)
        })
    } catch (err) {
        console.warn('Settings initialization callback failed', err)
    }
}

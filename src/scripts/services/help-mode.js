let hasExportedSettings = false
let helpModeShown = false
const ARCHIVE_PREFIX = 'bonjourr-archive-'
const ARCHIVE_DATABASE = 'bonjourr-archives'
const ARCHIVE_STORE = 'archives'

globalThis.window.addEventListener('load', function () {
    // if Bonjourr hasn't loaded after 5s, shows prompt
    globalThis.setTimeout(() => {
        displayHelpModePrompt()
    }, 5000)

    document.addEventListener('keydown', function (event) {
        // help mode ctrl + shift + ? hotkey
        const { key, shiftKey, ctrlKey, metaKey } = event
        const questionMarkKey = key === ',' || key === '/' || key === '?'
        const helpHotkey = (ctrlKey || metaKey) && shiftKey && questionMarkKey

        if (helpHotkey) {
            toggleHelpMode()
        }

        // when help mode is open, escape to quit
        if (key === 'Escape' && helpModeShown) {
            toggleHelpMode(false)
        }
    })
})

function displayHelpModePrompt() {
    if (!document.body.className.includes('init')) {
        return
    }

    const template = document.getElementById('help-mode-prompt-template')
    const fragment = template.content.cloneNode(true)
    const container = fragment.querySelector('#help-mode-prompt')
    document.documentElement.prepend(container)

    document.getElementById('open-help-mode')?.addEventListener('click', () => toggleHelpMode(true))

    document.querySelector('.export')?.addEventListener('click', downloadSettings)
}

function exportToJsonFile(json) {
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)

    const a = document.createElement('a')
    a.href = url
    a.download = `bonjourr-${new Date().toLocaleString()}.json`
    a.click()

    URL.revokeObjectURL(url) // clean up

    if (document.querySelector('.reset')) {
        document.querySelector('.reset').disabled = false
    }
    hasExportedSettings = true
}

async function downloadSettings() {
    exportToJsonFile(await getDataAsString())
}

/**
 * @returns Promise<string>
 */
async function getDataAsString() {
    if (typeof chrome !== 'undefined' && chrome?.storage) {
        const { syncStorage } = await chrome.storage.local.get('syncStorage')
        return JSON.stringify(syncStorage ?? {}, null, 2)
    }

    return localStorage.bonjourr ?? ''
}

// when reset button is clicked once, asks for confirmation
function resetOnce() {
    const resetBtn = document.querySelector('#help-mode .reset')
    const resetBtnSpan = resetBtn.querySelector('span')

    resetBtn.title = "You're about to reset Bonjourr to its default configuration."
    resetBtn.classList.add('danger')
    resetBtnSpan.textContent = 'Are you sure?'

    resetBtn.addEventListener('click', resetApply)
}

async function resetApply() {
    try {
        const archiveData = await getDataAsString()
        const archiveName = `${ARCHIVE_PREFIX}${new Date().toISOString()}`

        // Persist and verify a recoverable copy before touching any settings.
        // Help mode runs precisely when the main bundle may be broken, so it
        // cannot rely on the normal snapshot module being available.
        await saveRecoveryArchive(archiveName, archiveData)

        if (typeof chrome !== 'undefined' && chrome?.storage) {
            const current = await chrome.storage.local.get()
            const removableKeys = Object.keys(current).filter((key) =>
                key !== 'backgroundFiles' && !key.startsWith(ARCHIVE_PREFIX)
            )

            // User-selected background blobs live in CacheStorage and their
            // only index is backgroundFiles. A settings reset must preserve it.
            if (removableKeys.length > 0) {
                await chrome.storage.local.remove(removableKeys)
            }
        }

        for (const key of Object.keys(localStorage)) {
            const preserve = key === 'backgroundFiles' || key === 'update-archive' ||
                key.startsWith(ARCHIVE_PREFIX)
            if (!preserve) localStorage.removeItem(key)
        }
        sessionStorage.clear()
    } catch (err) {
        console.warn('Cannot safely reset Bonjourr', err)
        const resetBtnSpan = document.querySelector('#help-mode .reset span')
        if (resetBtnSpan) resetBtnSpan.textContent = 'Reset failed — data was not cleared'
        return
    }

    // Update button

    const resetBtn = document.querySelector('#help-mode .reset')
    const resetBtnSpan = resetBtn.querySelector('span')

    resetBtn.setAttribute('disabled', '')
    resetBtnSpan.textContent = 'Waiting for reload'

    // Reload to all back defaults

    setTimeout(() => {
        globalThis.window.location.reload()
    }, 1000)
}

async function saveRecoveryArchive(key, value) {
    if (typeof chrome !== 'undefined' && chrome?.storage) {
        await chrome.storage.local.set({ [key]: value })
        const stored = await chrome.storage.local.get(key)
        if (stored[key] !== value) throw new Error('Cannot verify the recovery archive')
        return
    }

    if (!globalThis.indexedDB) {
        throw new Error('Recovery archive storage is unavailable')
    }

    const database = await openArchiveDatabase()
    try {
        await new Promise((resolve, reject) => {
            const transaction = database.transaction(ARCHIVE_STORE, 'readwrite')
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => reject(transaction.error ?? new Error('Cannot write the recovery archive'))
            transaction.onabort = () => reject(transaction.error ?? new Error('Recovery archive write was aborted'))
            transaction.objectStore(ARCHIVE_STORE).put(value, key)
        })

        const stored = await new Promise((resolve, reject) => {
            const transaction = database.transaction(ARCHIVE_STORE, 'readonly')
            const request = transaction.objectStore(ARCHIVE_STORE).get(key)
            let result

            request.onsuccess = () => {
                result = request.result
            }
            transaction.oncomplete = () => resolve(result)
            transaction.onerror = () => reject(transaction.error ?? new Error('Cannot read the recovery archive'))
            transaction.onabort = () => reject(transaction.error ?? new Error('Recovery archive read was aborted'))
        })

        if (stored !== value) throw new Error('Cannot verify the recovery archive')
    } finally {
        database.close()
    }
}

function openArchiveDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(ARCHIVE_DATABASE, 1)
        let settled = false
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(ARCHIVE_STORE)) {
                request.result.createObjectStore(ARCHIVE_STORE)
            }
        }
        request.onsuccess = () => {
            if (settled) {
                request.result.close()
                return
            }
            settled = true
            resolve(request.result)
        }
        request.onerror = () => {
            if (settled) return
            settled = true
            reject(request.error ?? new Error('Cannot open recovery archive storage'))
        }
        request.onblocked = () => {
            if (settled) return
            settled = true
            reject(new Error('Recovery archive storage is blocked'))
        }
    })
}

/**
 * @param {boolean} on
 * @returns {void}
 */
function toggleHelpMode(on = !helpModeShown) {
    // first time
    if (!document.getElementById('help-mode')) {
        createHelpModeDisplay()
    }

    if (on) {
        // not using display: none, otherwise it disables events
        document.querySelector('body')?.setAttribute('style', 'position: fixed; visibility: hidden')
        document.querySelector('#help-mode')?.classList.add('shown')
    } else {
        document.querySelector('body')?.removeAttribute('style')
        document.querySelector('#help-mode')?.classList.remove('shown')
    }

    helpModeShown = !helpModeShown
}

/**
 * @returns {void}
 */
function createHelpModeDisplay() {
    const template = document.getElementById('help-mode-template')
    const fragment = template.content.cloneNode(true)
    const container = fragment.querySelector('#help-mode')
    document.documentElement.prepend(container)

    const resetBtn = this.document.querySelector('.reset')
    this.document.querySelector('.export').addEventListener('click', downloadSettings)
    resetBtn.addEventListener('click', resetOnce)

    if (hasExportedSettings) {
        resetBtn.disabled = false
    }

    // LocalStorage
    if (Object.entries(localStorage).length !== 0) {
        for (const [key, val] of Object.entries(localStorage)) {
            if (val === 'undefined' || val === '' || val === '{}' || val === '0') {
                continue
            }

            const li = document.createElement('li')
            const p = document.createElement('p')
            const pre = document.createElement('pre')

            p.textContent = key
            pre.textContent = val

            li.append(p, pre)
            container.querySelector('#help-localstorage')?.append(li)
        }

        container.querySelector('#localstorage-container')?.classList.remove('hidden')
    }

    // Chrome storage
    if (typeof chrome !== 'undefined' && chrome?.storage) {
        chrome.storage.local.get('syncStorage').then((data) => {
            container.querySelector('#help-storage-sync').textContent = JSON.stringify(
                data.syncStorage ?? {},
                undefined,
                2,
            )
            container.querySelector('#syncstorage-container')?.classList.remove('hidden')
        }).catch((err) => console.warn('Cannot read extension settings', err))

        chrome.storage.local.get().then((data) => {
            container.querySelector('#help-storage-local').textContent = JSON.stringify(data, undefined, 2)
            container.querySelector('#browserstorage-container')?.classList.remove('hidden')
        }).catch((err) => console.warn('Cannot read extension storage', err))
    }
}

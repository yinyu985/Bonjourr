import { darkmode, favicon, tabTitle } from './features/others.ts'
import { customFont, fontIsAvailableInSubset } from './features/fonts.ts'
import {
    backgroundUpdate,
    initBackgroundOptions,
    waitForPendingBackgroundWrites,
} from './features/backgrounds/index.ts'
import { resetBackgroundRuntimeCache } from './features/backgrounds/cache.ts'
import { changeFolderTitle, initFolders } from './features/links/groups.ts'
import { synchronization, withSynchronizationLock } from './features/synchronization/index.ts'
import {
    getConfigSnapshots,
    restoreConfigSnapshot,
    saveConfigSnapshot,
    saveExternalConfigSnapshot,
} from './features/synchronization/backup.ts'
import { assertValidNormalizedSync, assertValidSyncInput } from './features/synchronization/validation.ts'
import { hideElements } from './features/hide.ts'
import { buildBookmarkSnapshotFromConfig, linksImport, replaceBookmarksFromConfig } from './features/links/bookmarks.ts'
import { quickLinks } from './features/links/index.ts'
import { syncWithBookmarks } from './features/links/model.ts'
import { clock } from './features/clock/index.ts'

import { colorInput, fadeOut, webkitRangeTrackColor } from './shared/dom.ts'
import { initCustomSelects, refreshCustomSelects } from './shared/custom-select.ts'
import { CURRENT_VERSION, IS_MOBILE, PLATFORM, SYNC_DEFAULT } from './defaults.ts'
import { toggleTraduction, tradThis, traduction } from './utils/translations.ts'
import { settingsNotifications } from './utils/notifications.ts'
import { getPermissions } from './utils/permissions.ts'
import { loadCallbacks } from './utils/onsettingsload.ts'
import { onclickdown } from './utils/clickdown.ts'
import { mergeImportedConfig } from './compatibility/apply.ts'
import { stringify } from './utils/stringify.ts'
import { cancelPendingDebounces, debounce, flushPendingDebounces } from './utils/debounce.ts'
import { langList } from './langs.ts'
import { normalizeUnsplashAccessKey, storage } from './storage.ts'
import { parse } from './utils/parse.ts'

import type { Langs } from '../types/shared.ts'
import type { Sync, SyncSnapshot } from '../types/sync.ts'
import type { Local } from '../types/local.ts'
import type { BackgroundUpdate } from './features/backgrounds/index.ts'

// Initialization

let settingsJsonUpdateQueue: Promise<void> = Promise.resolve()
let unsplashAccessKeyAvailable = false

function runBackgroundUpdate(update: BackgroundUpdate): void {
    void backgroundUpdate(update).catch((err) => {
        console.warn('Background update failed', err)
    })
}

function runSettingsTask(label: string, task: () => Promise<unknown>): void {
    try {
        void task().catch((err) => console.warn(`${label} failed`, err))
    } catch (err) {
        console.warn(`${label} failed`, err)
    }
}

export function settingsInit(sync: Sync, local: Local): void {
    const showsettings = document.getElementById('show-settings')
    const shownotes = document.getElementById('show-notes')
    const settings = document.getElementById('settings')

    showsettings?.classList.add('he_hidden')
    shownotes?.classList.add('he_hidden')

    settings?.removeAttribute('style')
    settings?.classList.remove('hidden')
    document.dispatchEvent(new Event('settings'))

    document.addEventListener(
        'toggle-settings',
        ((e: CustomEvent) => {
            settingsToggle(e)
        }) as EventListener,
    )

    traduction(settings, sync.lang)
    translatePlaceholders()
    initBackgroundOptions(sync, local)
    initOptionsValues(sync, local)
    if (settings) {
        initCustomSelects(settings)
    }
    initOptionsEvents()
    settingsFooter()

    setTimeout(() => {
        updateSettingsJson()
        updateSettingsEvent()
        translateAriaLabels()
        settingsDrawerBar()
        void renderSnapshotsList().catch((err) => console.warn('Cannot render recovery snapshots', err))
        loadCallbacks()

        settings?.classList.remove('init')
    }, 500)
}

function settingsToggle(event?: CustomEvent): void {
    const domshowsettings = document.getElementById('show-settings')
    const domsettings = document.getElementById('settings')
    const isClosed = domsettings?.classList.contains('shown') === false

    const scrollTo = event?.detail?.scrollTo ?? false
    const target = domsettings?.querySelector(scrollTo)

    // scrolls requested section into view
    if (target && domsettings) {
        // starts scrolling only once the settings have been rendered (otherwise starts full animation again even if unnecessary)
        requestAnimationFrame(() => {
            setTimeout(() => {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }, 0)
        })
    }

    // prevents closing if a scrollTo has been requested
    if (!isClosed && scrollTo) return

    // Move focus out before hiding to avoid "aria-hidden on focused element" warning
    if (!isClosed && domsettings?.contains(document.activeElement)) {
        ;(document.activeElement as HTMLElement)?.blur()
    }

    domsettings?.classList.toggle('shown', isClosed)
    domsettings?.setAttribute('aria-hidden', String(!isClosed))
    domsettings?.toggleAttribute('inert', !isClosed)
    domshowsettings?.classList.toggle('shown', isClosed)

    domsettings?.style.removeProperty('transform')
    domsettings?.style.removeProperty('transition')
    document.dispatchEvent(new Event('close-edit'))
}

function initOptionsValues(data: Sync, local: Local): void {
    const domsettings = document.getElementById('settings') as HTMLElement

    setInput('i_blur', data.backgrounds.blur ?? 15)
    setInput('i_bright', data.backgrounds.bright ?? 0.8)
    setInput('i_linkstyle', data.links.style || 'default')
    setInput('i_type', data.backgrounds.type || 'images')
    setInput('i_freq', data.backgrounds?.frequency || 'hour')
    setInput('i_dark', data.dark || 'system')
    setInput('i_favicon', data.favicon ?? '')
    setInput('i_tabtitle', data.tabtitle ?? '')
    setInput('i_solid-background', data.backgrounds.color ?? '#185A63')
    setInput('i_texture', data.backgrounds.texture.type ?? 'none')
    setInput('i_texture-size', data.backgrounds.texture.size ?? '220')
    setInput('i_texture-opacity', data.backgrounds.texture.opacity ?? '0.1')
    setInput('i_texture-color', data.backgrounds.texture.color ?? '#ffffff')
    setInput('i_dateformat', data.dateformat || 'eu')
    setInput('i_clocksize', data.clock?.size ?? 1)
    setInput('i_weight', data.font?.weight || '300')
    setInput('i_size', clampFontSize(data.font?.size || (IS_MOBILE ? '11' : '14')))
    setInput('i_synctype', local.syncType ?? (PLATFORM === 'online' ? 'off' : 'gist'))

    setFormInput('i_gistsync', 'github_pat_XXXXXXXXXXXX', local?.gistToken)
    initUnsplashAccessKey(local.unsplashAccessKey)

    setCheckbox('i_quicklinks', data.links.enabled)
    setCheckbox('i_linkgroups', data.links.foldersOn)
    setCheckbox('i_linknewtab', data.links.newTab)
    setCheckbox('i_time', data.time)
    setCheckbox('i_seconds', data.clock?.seconds ?? false)
    setCheckbox('i_ampm', data.clock?.ampm ?? false)
    colorInput('solid-background', data.backgrounds.color)
    colorInput('texture-color', data.backgrounds.texture.color ?? '#ffffff')

    // Change edit tips on mobile
    if (IS_MOBILE) {
        const tooltiptext = domsettings.querySelector('.tooltiptext .instructions')
        const text = tradThis('Edit your Quick Links by long-pressing the icon.')

        if (tooltiptext) {
            tooltiptext.textContent = text
        }
    }

    // inserts languages in select
    const langInput = paramId('i_lang')

    for (const [code, title] of Object.entries(langList)) {
        const option = document.createElement('option')
        option.value = code
        option.text = title
        langInput.appendChild(option)
    }

    // must be init after children appening
    setInput('i_lang', data.lang || 'en')

    // Activate feature options
    paramId('time_options')?.classList.toggle('shown', data.time)
    paramId('quicklinks_options')?.classList.toggle('shown', data.links.enabled)
    paramId('linkgroups_options')?.classList.toggle('shown', data.links.foldersOn)

    // Time hide elems
    const dateOnly = data.hide?.clock
    const clockOnly = data.hide?.date
    let hideTime = 'all'

    if (dateOnly) {
        hideTime = 'date'
    } else if (clockOnly) {
        hideTime = 'clock'
    }

    setInput('i_timehide', hideTime)

    const settingsForms = document.querySelectorAll<HTMLFormElement>('#settings form')

    for (const form of settingsForms) {
        const inputs = form.querySelectorAll<HTMLInputElement>('input')

        for (const input of inputs) {
            input.addEventListener('input', () => {
                form.classList.toggle('valid', form.checkValidity())
            })
        }
    }

    // required for the range input's track color separation to work in webkit browsers
    // yes, it blows.
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
        webkitRangeTrackColor(input)

        input.addEventListener('input', () => {
            input.style.setProperty('--value', input.value)
        })
    }
}

function initOptionsEvents(): void {
    onclickdown(paramId('b_accept-permissions'), () => {
        runSettingsTask('Bookmark permission request', async () => {
            await getPermissions('bookmarks')

            const sync = await storage.sync.get()
            const local = await storage.local.get()
            await quickLinks({ sync, local })
            setTimeout(() => {
                runSettingsTask('Bookmark folder initialization', async () => {
                    initFolders(await buildBookmarkSnapshotFromConfig(sync))
                })
            }, 10)

            settingsNotifications({ 'accept-permissions': false })
        })
    })

    // General

    paramId('i_lang').addEventListener('change', function (): void {
        runSettingsTask('Language update', () => switchLangs(this.value as Langs))
    })

    paramId('i_favicon').addEventListener('input', function (this: HTMLInputElement): void {
        favicon(this.value, true)
    })

    paramId('i_favicon').addEventListener('change', function (): void {
        this.blur()
    })

    paramId('i_tabtitle').addEventListener('input', function (): void {
        tabTitle(this.value, true)
    })

    paramId('i_tabtitle').addEventListener('change', function (): void {
        this.blur()
    })

    paramId('i_dark').addEventListener('change', function (): void {
        darkmode(this.value as 'auto' | 'system' | 'enable' | 'disable', true)
    })

    // Quick links

    onclickdown(paramId('i_quicklinks'), (_, target) => {
        document.getElementById('linkblocks')?.classList.toggle('hidden', !target.checked)
        runSettingsTask('Quick links visibility update', () =>
            storage.sync.update((data) => {
                data.links.enabled = target.checked
            }))
    })

    onclickdown(paramId('i_linkgroups'), (_, target) => {
        paramId('linkgroups_options')?.classList.toggle('shown', target.checked)
        runSettingsTask('Quick link folders update', () => quickLinks(undefined, { folders: target.checked }))
    })

    onclickdown(paramId('i_linknewtab'), (_, target) => {
        runSettingsTask('Quick link target update', () => quickLinks(undefined, { newtab: target.checked }))
    })

    paramId('i_linkstyle').addEventListener('change', function (this): void {
        runSettingsTask('Quick link style update', () => quickLinks(undefined, { styles: { style: this.value } }))
    })

    onclickdown(paramId('b_importbookmarks'), () => {
        runSettingsTask('Bookmark import', async () => {
            await getPermissions('bookmarks')
            await linksImport()
        })
    })

    // Backgrounds

    paramId('i_type').addEventListener('change', function (this: HTMLInputElement): void {
        void backgroundUpdate({ type: this.value }).then(updateUnsplashAccessKeyVisibility).catch((err) => {
            console.warn('Background update failed', err)
        })
    })

    paramId('b_solid-background').addEventListener('click', function (): void {
        paramId('i_solid-background').click()
    })

    paramId('i_solid-background').addEventListener('input', function (): void {
        runBackgroundUpdate({ color: this.value })
    })

    const saveBackgroundProvider = function (this: HTMLInputElement): void {
        updateUnsplashAccessKeyVisibility()
        runBackgroundUpdate({ provider: this.value })
    }

    paramId('i_background-provider').addEventListener('input', saveBackgroundProvider)
    paramId('i_background-provider').addEventListener('change', saveBackgroundProvider)

    const saveBackgroundQueryDraft = debounce((query: { targetId: string; value: string }) => {
        void backgroundUpdate({ querydraft: query }).then(() => updateSettingsJson()).catch((err) => {
            console.warn('Background query draft failed', err)
        })
    }, 250)

    const saveBackgroundQuery = (event: Event): void => {
        const target = event.currentTarget as HTMLFormElement | HTMLInputElement
        const input = target instanceof HTMLInputElement ? target : target.querySelector<HTMLInputElement>('input')

        void backgroundUpdate({
            query: {
                targetId: target.id,
                value: input?.value ?? '',
            },
        }).then(() => updateSettingsJson()).catch((err) => {
            console.warn('Background query update failed', err)
        })
    }

    const queueBackgroundQueryDraft = (event: Event): void => {
        const target = event.currentTarget as HTMLInputElement

        saveBackgroundQueryDraft({
            targetId: target.id,
            value: target.value,
        })
    }

    paramId('f_background-user-coll').addEventListener('submit', function (event: SubmitEvent): void {
        event.preventDefault()
        saveBackgroundQuery(event)
    })

    paramId('f_background-user-search').addEventListener('submit', function (event: SubmitEvent): void {
        event.preventDefault()
        saveBackgroundQuery(event)
    })

    paramId('i_background-user-coll').addEventListener('change', saveBackgroundQuery)
    paramId('i_background-user-coll').addEventListener('blur', saveBackgroundQuery)
    paramId('i_background-user-coll').addEventListener('input', queueBackgroundQueryDraft)
    paramId('i_background-user-search').addEventListener('change', saveBackgroundQuery)
    paramId('i_background-user-search').addEventListener('blur', saveBackgroundQuery)
    paramId('i_background-user-search').addEventListener('input', queueBackgroundQueryDraft)

    initUnsplashAccessKeyEvents()

    paramId('i_freq').addEventListener('change', function (this: HTMLInputElement): void {
        runBackgroundUpdate({ freq: this.value })
    })

    onclickdown(paramId('i_refresh'), (event) => {
        runBackgroundUpdate({ refresh: event })
    })

    paramId('i_background-upload').addEventListener('change', function (this: HTMLInputElement): void {
        runBackgroundUpdate({ files: this.files })
    })

    onclickdown(paramId('b_background-urls'), () => {
        runBackgroundUpdate({ urlsapply: true })
    })

    // Background filters

    paramId('i_texture').addEventListener('change', function (this: HTMLInputElement): void {
        runBackgroundUpdate({ texture: this.value })
    })

    paramId('b_texture-color').addEventListener('click', function (): void {
        paramId('i_texture-color').click()
    })

    paramId('i_texture-color').addEventListener('input', function (): void {
        runBackgroundUpdate({ texturecolor: this.value })
    })

    paramId('i_texture-size').addEventListener('input', function (this: HTMLInputElement): void {
        runBackgroundUpdate({ texturesize: this.value })
    })

    paramId('i_texture-opacity').addEventListener('input', function (this: HTMLInputElement): void {
        runBackgroundUpdate({ textureopacity: this.value })
    })

    paramId('i_blur').addEventListener('pointerdown', function (this: HTMLInputElement): void {
        runBackgroundUpdate({ blurenter: true })
    })

    paramId('i_blur').addEventListener('input', function (this: HTMLInputElement): void {
        runBackgroundUpdate({ blur: this.value })
    })

    paramId('i_bright').addEventListener('input', function (this: HTMLInputElement): void {
        runBackgroundUpdate({ bright: this.value })
    })

    // Time and date

    onclickdown(paramId('i_time'), (_, target) => {
        document.getElementById('time')?.classList.toggle('hidden', !target.checked)
        runSettingsTask('Clock visibility update', () => storage.sync.set({ time: target.checked }))
    })

    onclickdown(paramId('i_seconds'), (_, target) => {
        clock(undefined, { seconds: target.checked })
    })

    paramId('i_clocksize').addEventListener('input', function (this: HTMLInputElement): void {
        clock(undefined, { size: Number.parseFloat(this.value) })
    })

    onclickdown(paramId('i_ampm'), (_, target) => {
        clock(undefined, { ampm: target.checked })
    })

    paramId('i_dateformat').addEventListener('change', function (this): void {
        clock(undefined, { dateformat: this.value })
    })

    paramId('i_timehide').addEventListener('change', function (this: HTMLInputElement): void {
        runSettingsTask(
            'Clock element visibility update',
            () => hideElements({ clock: this.value === 'clock', date: this.value === 'date' }, { isEvent: true }),
        )
    })

    // Custom fonts

    paramId('i_customfont').addEventListener('focus', () => {
        customFont(undefined, { autocomplete: true })
    })

    paramId('i_customfont').addEventListener('change', function (): void {
        customFont(undefined, { family: this.value })
    })

    paramId('i_weight').addEventListener('input', function (): void {
        customFont(undefined, { weight: this.value })
    })

    paramId('i_size').addEventListener('input', function (): void {
        customFont(undefined, { size: this.value })
    })

    // Sync

    paramId('i_synctype').addEventListener('change', function (this): void {
        runSettingsTask('Synchronization provider update', () => synchronization(undefined, { type: this.value }))
    })

    paramId('f_gistsync').addEventListener('submit', function (this, event): void {
        event.preventDefault()
        runSettingsTask(
            'Synchronization token update',
            () => synchronization(undefined, { gistToken: paramId('i_gistsync').value }),
        )
    })

    onclickdown(paramId('b_gistup'), () => {
        runSettingsTask('Manual synchronization upload', () => synchronization(undefined, { up: true }))
    })

    armConfirmOverwrite(paramId('b_gistdown'), () => {
        runSettingsTask('Manual synchronization download', () => synchronization(undefined, { down: true }))
    })

    // Settings managment

    paramId('settings-managment').addEventListener('dragenter', () => {
        paramId('settings-managment').classList.add('dragging-file')
    })

    paramId('file-import').addEventListener('dragleave', () => {
        paramId('settings-managment').classList.remove('dragging-file')
    })

    paramId('b_file-load').addEventListener('click', function (this): void {
        paramId('file-import')?.click()
    })

    paramId('b_file-save').addEventListener('click', () => {
        runSettingsTask('Settings export', saveImportFile)
    })

    paramId('file-import').addEventListener('change', function (this): void {
        loadImportFile(this)
    })

    paramId('b_settings-copy').addEventListener('click', () => {
        runSettingsTask('Settings copy', copySettings)
    })

    // input 触发的 'input' 分支会跑 chrome.bookmarks.getTree + 全表 stringify。
    // 不防抖的话粘贴 JSON 时会触发几十次 bookmarks API 调用。
    const debouncedToggle = debounce(() => toggleSettingsChangesButtons('input'), 200)
    paramId('settings-data').addEventListener('input', () => {
        debouncedToggle()
    })

    paramId('settings-data').addEventListener('focus', (event) => {
        runSettingsTask('Settings editor focus update', () => toggleSettingsChangesButtons(event.type))
    })

    paramId('settings-data').addEventListener('blur', (event) => {
        runSettingsTask('Settings editor blur update', () => toggleSettingsChangesButtons(event.type))
    })

    onclickdown(paramId('b_settings-cancel'), () => {
        runSettingsTask('Settings editor cancel', () => toggleSettingsChangesButtons('cancel'))
    })

    armConfirmOverwrite(paramId('b_settings-apply'), () => {
        const val = paramId('settings-data').value
        runSettingsTask('Settings import', () => importSettings(parse<Partial<Sync>>(val) ?? {}))
    })

    onclickdown(paramId('b_reset-first'), () => {
        runSettingsTask('Settings reset confirmation', () => resetSettings('first'))
    })

    onclickdown(paramId('b_reset-apply'), () => {
        runSettingsTask('Settings reset', () => resetSettings('yes'))
    })

    onclickdown(paramId('b_reset-cancel'), () => {
        runSettingsTask('Settings reset cancellation', () => resetSettings('no'))
    })

    // Other

    if (IS_MOBILE) {
        const rangeInputs = document.querySelectorAll<HTMLInputElement>("input[type='range'")

        const reduceSettingsOpacity = (event: TouchEvent) => {
            document.getElementById('settings')?.classList.toggle('see-through', event.type === 'touchstart')
        }

        for (const input of rangeInputs) {
            input.addEventListener('touchstart', reduceSettingsOpacity, { passive: true })
            input.addEventListener('touchend', reduceSettingsOpacity, { passive: true })
        }
    }

    const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]')

    for (const input of fileInputs) {
        const toggleDrag = (_: DragEvent) => {
            input.classList.toggle('dragover')
        }

        input?.addEventListener('dragenter', toggleDrag)
        input?.addEventListener('dragleave', toggleDrag)
        input?.addEventListener('drop', toggleDrag)
    }

    const tooltips = document.querySelectorAll<HTMLElement>('.tooltip')

    for (const tooltip of tooltips) {
        onclickdown(tooltip, () => {
            const classes = [...tooltip.classList]
            const ttclass = classes.filter((cl) => cl.startsWith('tt'))[0]
            const tttext = document.querySelector(`.tooltiptext.${ttclass}`)

            tttext?.classList.toggle('shown')
        })
    }

    const splitRangeButtons = document.querySelectorAll<HTMLButtonElement>('.split-range button')

    for (const button of splitRangeButtons) {
        onclickdown(button, () => {
            button.classList.toggle('on')
        })
    }
}

function translatePlaceholders(): void {
    const cases = [
        ['i_tabtitle', 'New tab'],
        ['css-editor-textarea', 'Type in your custom CSS'],
    ]

    for (const [id, text] of cases) {
        document.getElementById(id)?.setAttribute('placeholder', tradThis(text))
    }
}

function translateAriaLabels(): void {
    for (const element of document.querySelectorAll('[title]')) {
        const title = element.getAttribute('title') ?? ''

        element.setAttribute('title', tradThis(title))
        element.setAttribute('aria-label', tradThis(title))
    }
}

function initUnsplashAccessKey(accessKey?: string): void {
    const input = paramId('i_unsplash-access-key')
    const normalized = normalizeUnsplashAccessKey(accessKey)

    unsplashAccessKeyAvailable = normalized !== undefined
    input.value = normalized ?? ''
    input.removeAttribute('aria-invalid')
    resetUnsplashAccessKeyVisibility()
    paramId('b_unsplash-access-key-remove').disabled = !unsplashAccessKeyAvailable
    paramId('b_unsplash-access-key-toggle').disabled = input.value.length === 0
    updateUnsplashAccessKeyVisibility()
}

function initUnsplashAccessKeyEvents(): void {
    const form = paramId('f_unsplash-access-key') as unknown as HTMLFormElement
    const input = paramId('i_unsplash-access-key')
    const toggle = paramId('b_unsplash-access-key-toggle')
    const remove = paramId('b_unsplash-access-key-remove')

    input.addEventListener('input', () => {
        input.setCustomValidity('')
        input.removeAttribute('aria-invalid')
        toggle.disabled = input.value.length === 0
        setUnsplashAccessKeyStatus()
    })

    toggle.addEventListener('click', () => {
        const reveal = input.type === 'password'
        input.type = reveal ? 'text' : 'password'
        toggle.setAttribute('aria-pressed', String(reveal))
        setUnsplashAccessKeyToggleText(reveal)
        input.focus()
    })

    form.addEventListener('submit', (event) => {
        event.preventDefault()
        const accessKey = normalizeUnsplashAccessKey(input.value)

        if (!accessKey) {
            const message = tradThis('Enter a valid Unsplash Access Key.')
            input.setCustomValidity(message)
            input.setAttribute('aria-invalid', 'true')
            setUnsplashAccessKeyStatus('Enter a valid Unsplash Access Key.', 'error')
            input.focus()
            return
        }

        runSettingsTask('Unsplash Access Key update', async () => {
            setUnsplashAccessKeyControlsDisabled(true)
            try {
                await storage.local.set({ unsplashAccessKey: accessKey })
                input.value = accessKey
                input.setCustomValidity('')
                input.removeAttribute('aria-invalid')
                unsplashAccessKeyAvailable = true
                resetUnsplashAccessKeyVisibility()
                updateUnsplashAccessKeyVisibility()
                setUnsplashAccessKeyStatus('Unsplash Access Key saved.', 'success')
                dispatchUnsplashAccessKeyChange(true)
            } catch (err) {
                setUnsplashAccessKeyStatus('Could not save the Unsplash Access Key.', 'error')
                throw err
            } finally {
                setUnsplashAccessKeyControlsDisabled(false)
            }
        })
    })

    remove.addEventListener('click', () => {
        runSettingsTask('Unsplash Access Key removal', async () => {
            setUnsplashAccessKeyControlsDisabled(true)
            try {
                await storage.local.remove('unsplashAccessKey')
                input.value = ''
                input.setCustomValidity('')
                input.removeAttribute('aria-invalid')
                unsplashAccessKeyAvailable = false
                resetUnsplashAccessKeyVisibility()
                updateUnsplashAccessKeyVisibility()
                setUnsplashAccessKeyStatus('Unsplash Access Key removed.', 'success')
                dispatchUnsplashAccessKeyChange(false)
            } catch (err) {
                setUnsplashAccessKeyStatus('Could not remove the Unsplash Access Key.', 'error')
                throw err
            } finally {
                setUnsplashAccessKeyControlsDisabled(false)
            }
        })
    })
}

function updateUnsplashAccessKeyVisibility(): void {
    const isUnsplash = paramId('i_type').value === 'images' &&
        paramId('i_background-provider').value.startsWith('unsplash-')
    document.getElementById('unsplash-access-key-option')?.classList.toggle('shown', isUnsplash)
    document.getElementById('unsplash-access-key-required')?.classList.toggle(
        'shown',
        isUnsplash && !unsplashAccessKeyAvailable,
    )
}

function setUnsplashAccessKeyStatus(
    message?: string,
    state?: 'success' | 'error',
): void {
    const status = document.getElementById('unsplash-access-key-status')
    if (!status) return

    status.textContent = message ? tradThis(message) : ''
    status.classList.toggle('shown', message !== undefined)
    status.classList.toggle('success', state === 'success')
    status.classList.toggle('error', state === 'error')
}

function setUnsplashAccessKeyControlsDisabled(disabled: boolean): void {
    const input = paramId('i_unsplash-access-key')
    input.disabled = disabled
    paramId('b_unsplash-access-key-save').disabled = disabled
    paramId('b_unsplash-access-key-remove').disabled = disabled || !unsplashAccessKeyAvailable
    paramId('b_unsplash-access-key-toggle').disabled = disabled || input.value.length === 0
}

function resetUnsplashAccessKeyVisibility(): void {
    const input = paramId('i_unsplash-access-key')
    const toggle = paramId('b_unsplash-access-key-toggle')

    input.type = 'password'
    toggle.setAttribute('aria-pressed', 'false')
    setUnsplashAccessKeyToggleText(false)
}

function setUnsplashAccessKeyToggleText(revealed: boolean): void {
    const toggle = paramId('b_unsplash-access-key-toggle')
    const label = revealed ? 'Hide Access Key' : 'Show Access Key'
    const shortLabel = revealed ? 'Hide' : 'Show'

    toggle.setAttribute('title', tradThis(label))
    toggle.setAttribute('aria-label', tradThis(label))
    const span = toggle.querySelector('span')
    if (span) span.textContent = tradThis(shortLabel)
}

function dispatchUnsplashAccessKeyChange(available: boolean): void {
    document.dispatchEvent(new CustomEvent('unsplash-key-change', { detail: { available } }))
}

async function switchLangs(nextLang: Langs): Promise<void> {
    await toggleTraduction(nextLang)

    await storage.sync.set({ lang: nextLang })

    document.documentElement.setAttribute('lang', nextLang)

    const data = await storage.sync.get()

    data.lang = nextLang
    clock(data)
    changeFolderTitle({ old: '', new: '' }, data)
    tabTitle(data.tabtitle)
    customFont(undefined, { lang: true })
    settingsFooter()
    translatePlaceholders()
    translateAriaLabels()
    refreshCustomSelects(document.getElementById('settings') ?? document)
}

function settingsFooter(): void {
    const one = document.querySelector<HTMLAnchorElement>('#signature-one')
    const two = document.querySelector<HTMLAnchorElement>('#signature-two')
    const version = document.getElementById('version')

    if (one && two) {
        one.href = 'https://github.com/yinyu985'
        two.href = 'https://github.com/yinyu985/Bonjourr'
        one.textContent = 'yinyu985'
        two.textContent = 'Bonjourr (fork)'
    }

    if (version) {
        version.textContent = CURRENT_VERSION
    }
}

// 	Mobile settings drawer bar

function settingsDrawerBar(): void {
    const drawerDragDebounce = debounce(() => {
        ;(document.getElementById('settings-footer') as HTMLDivElement).style.removeProperty('padding')
    }, 600)

    globalThis.addEventListener('resize', () => {
        drawerDragDebounce()

        // removes transition to prevent weird movement when changing to mobile styling
        // /!\ this is dependent on settingsToggle() to remove inline styling /!\
        if (!document.getElementById('settings')?.style.transition) {
            document.getElementById('settings')?.setAttribute('style', 'transition: none')
        }
    })

    drawerDragEvents()
}

function drawerDragEvents(): void {
    const mobileDragZone = document.getElementById('mobile-drag-zone') as HTMLElement
    const settingsDom = document.getElementById('settings') as HTMLElement
    let settingsVh = -75
    let firstPos = 0
    let startTouchY = 0

    mobileDragZone?.addEventListener('touchstart', dragStart, {
        passive: false,
    })
    mobileDragZone?.addEventListener('pointerdown', dragStart, {
        passive: false,
    })

    function dragStart(e: Event): void {
        e.preventDefault()

        // prevents touchEvent and pointerEvent from firing at the same time
        if (settingsDom.classList.contains('dragging-mobile-settings')) {
            return
        }

        // Get mouse / touch y position
        if (e.type === 'pointerdown') {
            startTouchY = (e as MouseEvent).clientY
        }
        if (e.type === 'touchstart') {
            startTouchY = (e as TouchEvent).touches[0].clientY
        }

        // First time dragging, sets maximum y pos at which to block
        if (firstPos === 0) {
            firstPos = startTouchY
        }

        // Add mouse / touch moves events
        globalThis.addEventListener('touchmove', dragMove)
        globalThis.addEventListener('pointermove', dragMove)
        document.body.addEventListener('touchend', dragEnd)
        document.body.addEventListener('pointerup', dragEnd)

        document.body.classList.add('dragging-mobile-settings')
    }

    function dragMove(e: Event): void {
        let clientY = 0

        // Get mouse / touch y position
        if (e.type === 'pointermove') {
            clientY = (e as MouseEvent).clientY
        }
        if (e.type === 'touchmove') {
            clientY = (e as TouchEvent).touches[0].clientY
        }

        // element is below max height: keep dragging
        if (clientY > 60) {
            const touchPosition = clientY - 25
            const inverseHeight = 100 - (touchPosition / globalThis.innerHeight) * 100

            settingsVh = +inverseHeight.toFixed(2)
            settingsDom.style.transform = `translateY(-${settingsVh}dvh)`
            settingsDom.style.transition = 'transform .0s'
        }
    }

    function dragEnd(e: Event): void {
        let clientY = 0

        // Get mouse / touch y position
        if (e.type === 'pointerup') {
            clientY = (e as MouseEvent).clientY
        }
        if (e.type === 'touchend') {
            clientY = (e as TouchEvent).changedTouches[0].clientY
        }

        globalThis.removeEventListener('touchmove', dragMove)
        globalThis.removeEventListener('pointermove', dragMove)
        document.body.removeEventListener('touchend', dragEnd)
        document.body.removeEventListener('pointerup', dragEnd)

        startTouchY = 0

        const footer = document.getElementById('settings-footer') as HTMLDivElement
        footer.style.paddingBottom = `${100 - Math.abs(settingsVh)}dvh`

        settingsDom.style.removeProperty('padding')
        settingsDom.style.removeProperty('width')
        settingsDom.style.removeProperty('overflow')
        settingsDom.classList.remove('dragging')

        // small enough ? close settings
        if (clientY > globalThis.innerHeight - 100) {
            settingsToggle()
        }
    }
}

//	Settings management

async function copySettings(): Promise<void> {
    const copybtn = document.querySelector('#b_settings-copy span')

    try {
        const data = await getLatestExportData()
        const json = stringify(data)

        await navigator.clipboard.writeText(json)

        if (copybtn) {
            copybtn.textContent = tradThis('Copied!')
            setTimeout(() => {
                copybtn.textContent = tradThis('Copy')
            }, 1000)
        }
    } catch (error) {
        console.warn('Copy settings failed', error)
    }
}

async function getLatestExportData(): Promise<SyncSnapshot> {
    await flushPendingDebounces()
    await waitForPendingBackgroundWrites()
    return await buildBookmarkSnapshotFromConfig(await storage.sync.get())
}

async function saveImportFile(): Promise<void> {
    const a = document.getElementById('file-download')

    if (!a) {
        return
    }

    const date = new Date()
    const data = await getLatestExportData()
    const zero = (n: number) => (n.toString().length === 1 ? `0${n}` : n.toString())
    const yyyymmdd = date.toISOString().slice(0, 10)
    const hhmmss = `${zero(date.getHours())}_${zero(date.getMinutes())}_${zero(date.getSeconds())}`

    const bytes = new TextEncoder().encode(stringify(data))
    const blob = new Blob([bytes], { type: 'application/json;charset=utf-8' })
    const href = URL.createObjectURL(blob)

    a.setAttribute('href', href)
    a.setAttribute('tabindex', '-1')
    a.setAttribute('download', `bonjourr-${CURRENT_VERSION} ${yyyymmdd} ${hhmmss}.json`)
    a.click()
    setTimeout(() => URL.revokeObjectURL(href), 1000)
}

function loadImportFile(target: HTMLInputElement): void {
    function decodeExportFile(str: string): Partial<Sync> {
        let result = {}

        try {
            // Tries to decode base64 from previous versions
            result = parse<Partial<Sync>>(atob(str)) ?? {}
        } catch {
            try {
                // If base64 failed, parse raw string
                result = parse<Partial<Sync>>(str) ?? {}
            } catch (_) {
                // If all failed, return empty object
                result = {}
            }
        }

        return result
    }

    if (!target.files || (target.files && target.files.length === 0)) {
        return
    }

    const file = target.files[0]
    const reader = new FileReader()

    reader.onload = () => {
        if (typeof reader.result !== 'string') {
            console.warn('Imported settings file did not contain text')
            target.value = ''
            return
        }

        const importData = decodeExportFile(reader.result)

        // data has at least one valid key from default sync storage => import
        if (Object.keys(SYNC_DEFAULT).filter((key) => key in importData).length > 0) {
            runSettingsTask('Imported settings file', () => importSettings(importData as Sync))
        }

        target.value = ''
    }
    reader.onerror = () => {
        console.warn('Cannot read imported settings file', reader.error)
        target.value = ''
    }
    reader.onabort = () => {
        target.value = ''
    }
    reader.readAsText(file)
}

async function importSettings(imported: Partial<Sync>): Promise<void> {
    try {
        assertValidSyncInput(imported)

        // #308 - verify font subset before entering the destructive lock.
        if (imported?.font?.system === false) {
            const family = imported?.font?.family
            const lang = imported?.lang
            const correctSubset = await fontIsAvailableInSubset(lang, family)
            if (correctSubset === false) imported.font.family = ''
        }

        await withSynchronizationLock(async () => {
            await flushPendingDebounces()
            await storage.flushWrites()
            await storage.runExclusive(async (syncAccess) => {
                const current = await syncAccess.get()

                const importedData = mergeImportedConfig(structuredClone(current), imported)
                assertValidNormalizedSync(importedData)
                const importedLinks = imported.links as Record<string, unknown> | undefined
                const includesBookmarkSnapshot = Array.isArray(importedLinks?.folders) &&
                    Array.isArray(importedLinks?.favorites)
                const currentSnapshot = globalThis.chrome?.bookmarks
                    ? await buildBookmarkSnapshotFromConfig(current)
                    : syncWithBookmarks(structuredClone(current))
                await saveExternalConfigSnapshot(currentSnapshot, 'before-settings-import')

                storage.stageSyncForReload(importedData)
                try {
                    if (includesBookmarkSnapshot) {
                        await replaceBookmarksFromConfig(currentSnapshot, importedData)
                    }
                    await syncAccess.replace(importedData)
                    storage.clearStagedSyncForReload()
                } catch (error) {
                    try {
                        storage.stageSyncForReload(current)
                        if (includesBookmarkSnapshot) {
                            await replaceBookmarksFromConfig(importedData, currentSnapshot)
                        }
                        await syncAccess.replace(current)
                        storage.clearStagedSyncForReload()
                    } catch (rollbackError) {
                        throw new AggregateError([error, rollbackError], 'Import and automatic rollback both failed')
                    }
                    throw error
                }
                cancelPendingDebounces()
                await resetBackgroundRuntimeCache(importedData.backgrounds).catch((err) => {
                    console.warn('Imported background cache will be rebuilt after reload', err)
                })
                markConfigurationChanged()
            })
        })

        fadeOut()
    } catch (err) {
        console.warn('Import settings failed', err)
    }
}

async function resetSettings(action: 'yes' | 'no' | 'first'): Promise<void> {
    if (action === 'yes') {
        await withSynchronizationLock(async () => {
            await flushPendingDebounces()
            cancelPendingDebounces()
            await storage.flushWrites()
            await storage.runExclusive(async (syncAccess) => {
                const current = await syncAccess.get()
                await saveConfigSnapshot(current, 'before-settings-reset')
                try {
                    await resetBackgroundRuntimeCache(SYNC_DEFAULT.backgrounds)
                    await syncAccess.clearAll()
                } catch (error) {
                    await resetBackgroundRuntimeCache(current.backgrounds)
                    throw error
                }
            })
        })
        fadeOut()
        return
    }

    document.getElementById('reset-first')?.classList.toggle('shown', action === 'no')
    document.getElementById('reset-conf')?.classList.toggle('shown', action === 'first')
}

function markConfigurationChanged(): void {
    globalThis.dispatchEvent(new Event('bonjourr-sync-write'))
}

async function renderSnapshotsList(): Promise<void> {
    const container = document.getElementById('snapshots-list')
    if (!container) return

    const snapshots = await getConfigSnapshots()
    container.replaceChildren()

    for (let index = 0; index < snapshots.length; index++) {
        const snapshot = snapshots[index]
        const item = document.createElement('div')
        const info = document.createElement('div')
        const time = document.createElement('time')
        const reason = document.createElement('span')
        const button = document.createElement('button')

        item.className = 'wrapper snapshot-item'
        info.className = 'snapshot-info'
        time.className = 'snapshot-time'
        time.dateTime = snapshot.timestamp
        time.textContent = new Date(snapshot.timestamp).toLocaleString()
        reason.className = 'snapshot-reason'
        reason.textContent = snapshotReasonLabel(snapshot.reason)
        info.append(time, reason)
        button.className = 'param-btn trn'
        button.textContent = tradThis('Restore')
        onclickdown(button, async () => {
            button.disabled = true
            try {
                if (await restoreConfigSnapshot(index)) fadeOut()
            } catch (err) {
                console.warn('Snapshot restore failed', err)
                button.disabled = false
            }
        })
        item.append(info, button)
        container.appendChild(item)
    }
}

function snapshotReasonLabel(reason: string): string {
    switch (reason) {
        case 'before-settings-import':
            return tradThis('Import')
        case 'before-settings-reset':
            return tradThis('Reset all settings')
        case 'before-snapshot-restore':
            return tradThis('Restore')
        case 'before-remote-overwrite':
            return tradThis('Send')
        case 'before-sync-download':
            return tradThis('Get')
        default:
            return reason.replaceAll(/[-_]+/g, ' ').replace(/^./, (first) => first.toUpperCase())
    }
}

export async function updateSettingsJson(data?: Sync | SyncSnapshot): Promise<void> {
    const queuedUpdate = settingsJsonUpdateQueue.catch(() => {}).then(async () => {
        try {
            updateTextArea(data ?? await getLatestExportData())
        } catch (err) {
            console.warn(err)
        }
    })

    settingsJsonUpdateQueue = queuedUpdate
    await queuedUpdate

    function updateTextArea(data: Sync | SyncSnapshot): void {
        const pre = document.getElementById('settings-data') as HTMLTextAreaElement | null

        if (pre && data.links) {
            pre.value = stringify(data)
        }
    }
}

function updateSettingsEvent(): void {
    // On settings changes, update export code
    // beforeunload stuff
    const refreshSettingsJson = debounce(() => updateSettingsJson(), 100)
    const localStorageUpdate = (event: Event): void => {
        if (!(event instanceof StorageEvent) || event.key === null || event.key === 'bonjourr') {
            refreshSettingsJson()
        }
    }
    const webextStorageUpdate = (changes: Record<string, chrome.storage.StorageChange>): void => {
        if (changes.syncStorage) refreshSettingsJson()
    }

    if (PLATFORM === 'online') {
        globalThis.addEventListener('storage', localStorageUpdate)
    } else {
        chrome.storage.onChanged.addListener(webextStorageUpdate)
        globalThis.addEventListener('beforeunload', () => {
            refreshSettingsJson.cancel()
            chrome.storage.onChanged.removeListener(webextStorageUpdate)
        }, { once: true })
    }
}

async function toggleSettingsChangesButtons(action: string): Promise<void> {
    const textarea = paramId('settings-data')
    let hasChanges = false

    if (action === 'input') {
        const data = await getLatestExportData()
        const current = stringify(data)
        let user = ''

        try {
            user = stringify(JSON.parse(textarea.value ?? '{}') as Sync)
        } catch (err) {
            console.warn('Settings JSON parse error', err)
        }

        hasChanges = user.length > 2 && current !== user

        if (hasChanges) {
            paramId('b_settings-apply')?.removeAttribute('disabled')
        } else {
            paramId('b_settings-apply')?.setAttribute('disabled', '')
        }
    }

    if (action === 'cancel') {
        const data = await getLatestExportData()
        textarea.value = stringify(data)
        hasChanges = false
    }

    if (action === 'focus') {
        paramId('settings-files-options')?.classList.add('hidden')
        paramId('settings-changes-options')?.classList.remove('hidden')
    }

    if (action === 'blur') {
        paramId('settings-changes-options')?.classList.add('hidden')
        paramId('settings-files-options')?.classList.remove('hidden')
    }
}

function paramId(str: string): HTMLInputElement {
    return document.getElementById(str) as HTMLInputElement
}

function armConfirmOverwrite(button: HTMLInputElement, action: () => void): void {
    const CONFIRM_TIMEOUT_MS = 3000
    const span = button.querySelector('span')
    const img = button.querySelector('img')
    let armed = false
    let timer = 0
    let savedText = ''

    function disarm(): void {
        if (!armed) {
            return
        }
        armed = false
        if (span) {
            span.textContent = savedText
        }
        if (img) {
            img.style.display = ''
        }
        button.classList.remove('btn-red')
        if (timer) {
            clearTimeout(timer)
            timer = 0
        }
    }

    onclickdown(button, () => {
        if (button.hasAttribute('disabled')) {
            return
        }

        if (armed) {
            disarm()
            action()
            return
        }

        savedText = span?.textContent ?? ''
        armed = true
        if (span) {
            span.textContent = tradThis('Overwrite local?')
        }
        if (img) {
            img.style.display = 'none'
        }
        button.classList.add('btn-red')
        timer = setTimeout(disarm, CONFIRM_TIMEOUT_MS)
    })

    button.addEventListener('mouseleave', disarm)
}

function setCheckbox(id: string, cat: boolean): void {
    const checkbox = paramId(id) as HTMLInputElement
    checkbox.checked = cat
}

function setInput(id: string, val: string | number): void {
    const input = paramId(id) as HTMLInputElement
    input.value = typeof val === 'string' ? val : val?.toString()
}

function setFormInput(id: string, defaults: string, value?: string): void {
    const input = paramId(id) as HTMLInputElement

    if (value) {
        input.value = value
        input.setAttribute('placeholder', value)
    } else {
        input.setAttribute('placeholder', defaults)
    }
}

function clampFontSize(size: string): string {
    return Math.min(15, Math.max(7, Number.parseFloat(size))).toString()
}

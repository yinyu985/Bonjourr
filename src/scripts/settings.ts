import { darkmode, favicon, tabTitle } from './features/others.ts'
import { customFont, fontIsAvailableInSubset, systemfont } from './features/fonts.ts'
import { backgroundUpdate, initBackgroundOptions, toggleMuteStatus } from './features/backgrounds/index.ts'
import { changeFolderTitle, initFolders } from './features/links/groups.ts'
import { synchronization } from './features/synchronization/index.ts'
import { dedupeSyncLinks, mergeSyncAppend } from './features/synchronization/merge.ts'
import { hideElements } from './features/hide.ts'
import {
    bootstrapBookmarksFromConfig,
    linksImport,
    renderLinksFromSync,
    replaceBookmarksFromConfig,
    restoreBookmarksFromConfig,
} from './features/links/bookmarks.ts'
import { quickLinks } from './features/links/index.ts'
import { clock } from './features/clock/index.ts'
import { openSettingsButtonEvent } from './features/contextmenu.ts'

import { colorInput, fadeOut, webkitRangeTrackColor } from './shared/dom.ts'
import { initCustomSelects, refreshCustomSelects } from './shared/custom-select.ts'
import { BROWSER, IS_MOBILE, PLATFORM, SYNC_DEFAULT } from './defaults.ts'
import { toggleTraduction, tradThis, traduction } from './utils/translations.ts'
import { settingsNotifications } from './utils/notifications.ts'
import { getPermissions } from './utils/permissions.ts'
import { opacityFromHex } from './shared/generic.ts'
import { loadCallbacks } from './utils/onsettingsload.ts'
import { onclickdown } from 'clickdown/mod'
import { filterData } from './compatibility/apply.ts'
import { stringify } from './utils/stringify.ts'
import { debounce } from './utils/debounce.ts'
import { langList } from './langs.ts'
import { storage } from './storage.ts'
import { parse } from './utils/parse.ts'

import type { Langs } from '../types/shared.ts'
import type { Sync } from '../types/sync.ts'
import type { Local } from '../types/local.ts'

// Initialization

let settingsInitSync: Sync
let settingsInitLocal: Local
let settingsJsonUpdateId = 0

export function settingsInit(sync: Sync, local: Local): void {
    const showsettings = document.getElementById('show-settings')
    const shownotes = document.getElementById('show-notes')

    settingsInitSync = sync
    settingsInitLocal = local
    showsettings?.classList.add('he_hidden')
    shownotes?.classList.add('he_hidden')

    document.addEventListener('updateSettingsBeforeInit', (e) => {
        settingsInitSync = (e as CustomEvent).detail
    })

    document.body?.addEventListener('keydown', settingsInitEvent)
    showsettings?.addEventListener('pointerdown', settingsInitEvent)

    const openSettingsButtonsFromContextMenu = document.body.querySelectorAll<HTMLButtonElement>(
        `[data-action="openTheseSettings"]`,
    )

    openSettingsButtonsFromContextMenu.forEach((btn) => {
        btn?.addEventListener('pointerdown', settingsInitEvent)
    })
}

function settingsInitEvent(event: Event): void {
    const showsettings = document.getElementById('show-settings')
    const settings = document.getElementById('settings')

    // 1. When to load settings

    const settingsAreHidden = settings?.classList.contains('hidden')
    const isLeftClick = (event as PointerEvent)?.button === 0
    const isEscape = (event as KeyboardEvent)?.code === 'Escape'
    const canOpenSettings = settingsAreHidden && (isEscape || isLeftClick)

    if (!canOpenSettings) {
        return
    }

    // 2. To apply now

    const local = settingsInitLocal
    const sync = settingsInitSync

    settings?.removeAttribute('style')
    settings?.classList.remove('hidden')
    document.dispatchEvent(new Event('settings'))

    document.addEventListener(
        'toggle-settings',
        ((e: CustomEvent) => {
            settingsToggle(e)
        }) as EventListener,
    )

    // if init by touch, opens settings right away
    if ((event as PointerEvent).pointerType === 'touch') {
        // tricks the browser into thinking it's not the same event that inits and opens
        setTimeout(() => {
            // when requesting specific settings section
            if ((event.target as HTMLElement).getAttribute('data-attribute')) {
                openSettingsButtonEvent(event)
            } else {
                document.dispatchEvent(new CustomEvent('toggle-settings'))
            }
        }, 0)
    }

    document.body?.removeEventListener('keydown', settingsInitEvent)
    showsettings?.removeEventListener('pointerdown', settingsInitEvent)

    showall(sync.showall, false)
    traduction(settings, sync.lang)
    translatePlaceholders()
    initBackgroundOptions(sync, local)
    initOptionsValues(sync, local)
    if (settings) {
        initCustomSelects(settings)
    }
    initOptionsEvents()
    settingsFooter()

    // 3. Can be deferred

    setTimeout(() => {
        updateSettingsJson(sync)
        updateSettingsEvent()
        translateAriaLabels()
        settingsDrawerBar()
        loadCallbacks()

        settings?.classList.remove('init')
    }, 500)
}

function settingsToggle(event?: CustomEvent): void {
    const domshowsettings = document.getElementById('show-settings')
    const dominterface = document.getElementById('interface')
    const domsettings = document.getElementById('settings')
    const domedit = document.getElementById('editlink')
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
    domedit?.classList.toggle('pushed', isClosed)
    dominterface?.classList.toggle('pushed', isClosed)
    domshowsettings?.classList.toggle('shown', isClosed)

    domsettings?.style.removeProperty('transform')
    domsettings?.style.removeProperty('transition')
    document.dispatchEvent(new Event('close-edit'))
}

function initOptionsValues(data: Sync, local: Local): void {
    const domsettings = document.getElementById('settings') as HTMLElement

    setInput('i_blur', data.backgrounds.blur ?? 15)
    setInput('i_bright', data.backgrounds.bright ?? 0.8)
    setInput('i_fadein', data.backgrounds.fadein ?? 400)
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
    setInput('i_clockface', data.analogstyle?.face || 'none')
    setInput('i_clockhands', data.analogstyle?.hands || 'none')
    setInput('i_clockshape', data.analogstyle?.shape || 'round')
    setInput('i_analog-border-opacity', opacityFromHex(data.analogstyle?.border ?? '#ffff'))
    setInput('i_analog-background-opacity', opacityFromHex(data.analogstyle?.background ?? '#fff2'))
    setInput('i_clocksize', data.clock?.size ?? 1)
    setInput('i_weight', data.font?.weight || '300')
    setInput('i_size', clampFontSize(data.font?.size || (IS_MOBILE ? '11' : '14')))
    setInput('i_synctype', local.syncType ?? (PLATFORM === 'online' ? 'off' : 'gist'))

    setFormInput('i_customfont', systemfont.placeholder, data.font?.family)
    setFormInput('i_gistsync', 'github_pat_XX000X00X', local?.gistToken)
    setFormInput('i_urlsync', 'https://pastebin.com/raw/y7XhhiDs', local?.distantUrl)

    setCheckbox('i_showall', data.showall)
    setCheckbox('i_background-mute-videos', data.backgrounds.mute ?? true)
    setCheckbox('i_quicklinks', data.links.enabled)
    setCheckbox('i_linkgroups', data.links.foldersOn)
    setCheckbox('i_linknewtab', data.links.newTab)
    setCheckbox('i_time', data.time)
    setCheckbox('i_analog', data.clock?.analog ?? false)
    setCheckbox('i_seconds', data.clock?.seconds ?? false)
    setCheckbox('i_ampm', data.clock?.ampm ?? false)
    colorInput('solid-background', data.backgrounds.color)
    colorInput('texture-color', data.backgrounds.texture.color ?? '#ffffff')

    paramId('i_analog-border-shade')?.classList.toggle('on', (data.analogstyle?.border ?? '#fff').includes('#000'))
    paramId('i_analog-background-shade')?.classList.toggle(
        'on',
        (data.analogstyle?.background ?? '#fff').includes('#000'),
    )

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
    paramId('analog_options')?.classList.toggle('shown', data.clock.analog)
    paramId('digital_options')?.classList.toggle('shown', !data.clock.analog)
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

    // Change Sync name based on browser
    const browserSyncOption = document.querySelector<HTMLElement>("#i_synctype option[value='browser']")

    if (browserSyncOption) {
        if (PLATFORM === 'firefox') {
            browserSyncOption.textContent = 'Firefox Sync'
        } else if (PLATFORM === 'chrome' && BROWSER === 'edge') {
            browserSyncOption.textContent = 'Edge Sync'
        } else if (PLATFORM === 'chrome') {
            browserSyncOption.textContent = 'Chrome Sync'
        } else if (PLATFORM === 'safari') {
            browserSyncOption.textContent = 'Safari'
        } else {
            browserSyncOption.textContent = tradThis('Automatic')
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
    onclickdown(paramId('b_accept-permissions'), async () => {
        await getPermissions('bookmarks')

        const sync = await storage.sync.get()
        const local = await storage.local.get()
        quickLinks({ sync, local })
        setTimeout(() => initFolders(sync), 10)

        settingsNotifications({ 'accept-permissions': false })
    })

    // General

    onclickdown(paramId('i_showall'), (_, target) => {
        showall(target.checked, true)
    })

    paramId('i_lang').addEventListener('change', function (): void {
        switchLangs(this.value as Langs)
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

    onclickdown(paramId('i_quicklinks'), async (_, target) => {
        document.getElementById('linkblocks')?.classList.toggle('hidden', !target.checked)
        const data = await storage.sync.get()
        data.links.enabled = target.checked
        storage.sync.set({ links: data.links })
    })

    onclickdown(paramId('i_linkgroups'), (_, target) => {
        paramId('linkgroups_options')?.classList.toggle('shown', target.checked)
        quickLinks(undefined, { folders: target.checked })
    })

    onclickdown(paramId('i_linknewtab'), (_, target) => {
        quickLinks(undefined, { newtab: target.checked })
    })

    paramId('i_linkstyle').addEventListener('change', function (this): void {
        quickLinks(undefined, { styles: { style: this.value } })
    })

    onclickdown(paramId('b_importbookmarks'), async () => {
        await getPermissions('bookmarks')
        await linksImport()
    })

    // Backgrounds

    paramId('i_type').addEventListener('change', function (this: HTMLInputElement): void {
        backgroundUpdate({ type: this.value })
    })

    paramId('b_solid-background').addEventListener('click', function (): void {
        paramId('i_solid-background').click()
    })

    paramId('i_solid-background').addEventListener('input', function (): void {
        backgroundUpdate({ color: this.value })
    })

    paramId('i_background-provider').addEventListener('input', function (): void {
        backgroundUpdate({ provider: this.value })
    })

    paramId('f_background-user-coll').addEventListener('submit', function (this, event: SubmitEvent): void {
        backgroundUpdate({ query: event })
        event.preventDefault()
    })

    paramId('f_background-user-search').addEventListener('submit', function (this, event: SubmitEvent): void {
        backgroundUpdate({ query: event })
        event.preventDefault()
    })

    paramId('i_freq').addEventListener('change', function (this: HTMLInputElement): void {
        backgroundUpdate({ freq: this.value })
    })

    onclickdown(paramId('i_refresh'), (event) => {
        backgroundUpdate({ refresh: event })
    })

    paramId('i_background-upload').addEventListener('change', function (this: HTMLInputElement): void {
        backgroundUpdate({ files: this.files })
    })

    onclickdown(paramId('b_background-urls'), () => {
        backgroundUpdate({ urlsapply: true })
    })

    onclickdown(paramId('i_background-mute-videos'), (_, target) => {
        toggleMuteStatus(target.checked)
        backgroundUpdate({ mute: target.checked })
    })

    // Background filters

    paramId('i_texture').addEventListener('change', function (this: HTMLInputElement): void {
        backgroundUpdate({ texture: this.value })
    })

    paramId('b_texture-color').addEventListener('click', function (): void {
        paramId('i_texture-color').click()
    })

    paramId('i_texture-color').addEventListener('input', function (): void {
        backgroundUpdate({ texturecolor: this.value })
    })

    paramId('i_texture-size').addEventListener('input', function (this: HTMLInputElement): void {
        backgroundUpdate({ texturesize: this.value })
    })

    paramId('i_texture-opacity').addEventListener('input', function (this: HTMLInputElement): void {
        backgroundUpdate({ textureopacity: this.value })
    })

    paramId('i_blur').addEventListener('pointerdown', function (this: HTMLInputElement): void {
        backgroundUpdate({ blurenter: true })
    })

    paramId('i_blur').addEventListener('input', function (this: HTMLInputElement): void {
        backgroundUpdate({ blur: this.value })
    })

    paramId('i_bright').addEventListener('input', function (this: HTMLInputElement): void {
        backgroundUpdate({ bright: this.value })
    })

    paramId('i_fadein').addEventListener('input', function (this: HTMLInputElement): void {
        backgroundUpdate({ fadein: this.value })
    })

    // Time and date

    onclickdown(paramId('i_time'), (_, target) => {
        document.getElementById('time')?.classList.toggle('hidden', !target.checked)
        storage.sync.set({ time: target.checked })
    })

    onclickdown(paramId('i_analog'), (_, target) => {
        clock(undefined, { analog: target.checked })
    })

    onclickdown(paramId('i_seconds'), (_, target) => {
        clock(undefined, { seconds: target.checked })
    })

    paramId('i_clockface').addEventListener('change', function (this: HTMLInputElement): void {
        clock(undefined, { face: this.value })
    })

    paramId('i_clockhands').addEventListener('change', function (this: HTMLInputElement): void {
        clock(undefined, { hands: this.value })
    })

    paramId('i_analog-border-opacity').addEventListener('input', function (this: HTMLInputElement): void {
        clock(undefined, { border: 'opacity' })
    })

    paramId('i_analog-background-opacity').addEventListener('input', function (this: HTMLInputElement): void {
        clock(undefined, { background: 'opacity' })
    })

    paramId('i_analog-border-shade').addEventListener('click', () => {
        clock(undefined, { border: 'shade' })
    })

    paramId('i_analog-background-shade').addEventListener('click', () => {
        clock(undefined, { background: 'shade' })
    })

    paramId('i_clockshape').addEventListener('change', function (this: HTMLInputElement): void {
        clock(undefined, { shape: this.value })
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
        hideElements({ clock: this.value === 'clock', date: this.value === 'date' }, { isEvent: true })
    })

    // Custom fonts

    paramId('i_customfont').addEventListener('pointerenter', () => {
        customFont(undefined, { autocomplete: true })
    })

    paramId('f_customfont').addEventListener('submit', (event) => {
        customFont(undefined, { family: paramId('i_customfont').value })
        event.preventDefault()
    })

    paramId('i_weight').addEventListener('input', function (): void {
        customFont(undefined, { weight: this.value })
    })

    paramId('i_size').addEventListener('input', function (): void {
        customFont(undefined, { size: this.value })
    })

    // Sync

    paramId('i_synctype').addEventListener('change', function (this): void {
        synchronization(undefined, { type: this.value })
    })

    paramId('f_gistsync').addEventListener('submit', function (this, event): void {
        event.preventDefault()
        synchronization(undefined, { gistToken: paramId('i_gistsync').value })
    })

    paramId('f_urlsync').addEventListener('submit', function (this, event): void {
        event.preventDefault()
        synchronization(undefined, { url: paramId('i_urlsync').value })
    })

    onclickdown(paramId('b_storage-persist'), async () => {
        const persists = await navigator.storage.persist()
        synchronization(undefined, { firefoxPersist: persists })
    })

    onclickdown(paramId('b_gistup'), () => {
        synchronization(undefined, { up: true })
    })

    onclickdown(paramId('b_gistdown'), () => {
        synchronization(undefined, { down: true })
    })

    onclickdown(paramId('b_urldown'), () => {
        synchronization(undefined, { down: true })
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
        saveImportFile()
    })

    paramId('file-import').addEventListener('change', function (this): void {
        loadImportFile(this)
    })

    paramId('b_settings-copy').addEventListener('click', () => {
        copySettings()
    })

    paramId('settings-data').addEventListener('input', (event) => {
        toggleSettingsChangesButtons(event.type)
    })

    paramId('settings-data').addEventListener('focus', (event) => {
        toggleSettingsChangesButtons(event.type)
    })

    paramId('settings-data').addEventListener('blur', (event) => {
        toggleSettingsChangesButtons(event.type)
    })

    onclickdown(paramId('b_settings-cancel'), () => {
        toggleSettingsChangesButtons('cancel')
    })

    onclickdown(paramId('b_settings-apply'), () => {
        const val = paramId('settings-data').value
        importSettings(parse<Partial<Sync>>(val) ?? {}, 'replace')
    })

    onclickdown(paramId('b_reset-first'), () => {
        resetSettings('first')
    })

    onclickdown(paramId('b_reset-apply'), () => {
        resetSettings('yes')
    })

    onclickdown(paramId('b_reset-cancel'), () => {
        resetSettings('no')
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

async function switchLangs(nextLang: Langs): Promise<void> {
    await toggleTraduction(nextLang)

    storage.sync.set({ lang: nextLang })

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

function showall(val: boolean, event: boolean): void {
    document.getElementById('settings')?.classList.toggle('all', val)

    if (event) {
        storage.sync.set({ showall: val })
    }
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
        version.textContent = SYNC_DEFAULT.about.version
    }
}

// 	Mobile settings drawer bar

function settingsDrawerBar(): void {
    const drawerDragDebounce = debounce(() => {
        ;(document.getElementById('settings-footer') as HTMLDivElement).style.removeProperty('padding')
        drawerDragEvents()
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

        navigator.clipboard.writeText(json)

        if (copybtn) {
            copybtn.textContent = tradThis('Copied!')
            setTimeout(() => {
                copybtn.textContent = tradThis('Copy')
            }, 1000)
        }
    } catch (_error) {
        // ...
    }
}

async function getLatestExportData(): Promise<Sync> {
    return dedupeSyncLinks(await bootstrapBookmarksFromConfig(await storage.sync.get()))
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
    a.setAttribute('download', `bonjourr-${data?.about?.version} ${yyyymmdd} ${hhmmss}.json`)
    a.click()
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
            return false
        }

        const importData = decodeExportFile(reader.result)

        // data has at least one valid key from default sync storage => import
        if (Object.keys(SYNC_DEFAULT).filter((key) => key in importData).length > 0) {
            importSettings(importData as Sync, 'replace')
        }
    }
    reader.readAsText(file)
}

async function importSettings(imported: Partial<Sync>, mode: 'merge' | 'replace' = 'merge'): Promise<void> {
    try {
        const current = await storage.sync.get()

        // #308 - verify font subset before importing
        if (imported?.font?.system === false) {
            const family = imported?.font?.family
            const lang = imported?.lang
            const correctSubset = await fontIsAvailableInSubset(lang, family)

            if (correctSubset === false) {
                imported.font.family = ''
            }
        }

        const importedData = dedupeSyncLinks(filterData('import', structuredClone(SYNC_DEFAULT), imported))
        let data = mode === 'replace' ? importedData : mergeSyncAppend(current, importedData)

        if (mode === 'replace') {
            await replaceBookmarksFromConfig(current, importedData)
        }
        await storage.sync.clear()
        await storage.sync.set(data)
        if (mode === 'replace') {
            data = await bootstrapBookmarksFromConfig(data)
            await storage.sync.set(data)
            await renderLinksFromSync(data)
        } else if (await restoreBookmarksFromConfig(importedData)) {
            data = await bootstrapBookmarksFromConfig(data)
            await storage.sync.set(data)
        }
        fadeOut()
    } catch (_) {
        // ...
    }
}

function resetSettings(action: 'yes' | 'no' | 'first'): void {
    if (action === 'yes') {
        storage.clearall().then(fadeOut)
        return
    }

    document.getElementById('reset-first')?.classList.toggle('shown', action === 'no')
    document.getElementById('reset-conf')?.classList.toggle('shown', action === 'first')
}

export async function updateSettingsJson(data?: Sync): Promise<void> {
    const updateId = ++settingsJsonUpdateId

    try {
        const latest = data ?? await getLatestExportData()

        if (updateId === settingsJsonUpdateId) {
            updateTextArea(latest)
        }
    } catch (err) {
        console.warn(err)
    }

    function updateTextArea(data: Sync): void {
        const pre = document.getElementById('settings-data') as HTMLTextAreaElement | null

        if (pre && data.about) {
            const orderedJson = stringify(data)
            data.about.browser = PLATFORM
            pre.value = orderedJson
        }
    }
}

function updateSettingsEvent(): void {
    // On settings changes, update export code
    // beforeunload stuff
    const storageUpdate = () => updateSettingsJson()
    const removeListener = () => chrome.storage.onChanged.removeListener(storageUpdate)

    if (PLATFORM === 'online') {
        globalThis.addEventListener('storage', storageUpdate)
    } else {
        chrome.storage.onChanged.addListener(storageUpdate)
        globalThis.addEventListener('beforeunload', removeListener, { once: true })
    }
}

async function toggleSettingsChangesButtons(action: string): Promise<void> {
    const textarea = paramId('settings-data')
    const data = await getLatestExportData()
    let hasChanges = false

    if (action === 'input') {
        const current = stringify(data)
        let user = ''

        try {
            user = stringify(JSON.parse(textarea.value ?? '{}') as Sync)
        } catch (_) {
            //
        }

        hasChanges = user.length > 2 && current !== user

        if (hasChanges) {
            paramId('b_settings-apply')?.removeAttribute('disabled')
        } else {
            paramId('b_settings-apply')?.setAttribute('disabled', '')
        }
    }

    if (action === 'cancel') {
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

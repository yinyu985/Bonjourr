import { setUserDate, userDate } from '../../shared/time.ts'
import { clockDate } from './date.ts'
import { fixunits } from './helpers.ts'

import type { Clock } from '../../../types/sync.ts'
import type { DateFormat } from './date.ts'

export interface ClockStartOptions {
    clock: Clock
    dateformat: DateFormat
}

let clockTimer = 0
let activeOptions: ClockStartOptions | undefined
let lifecycleBound = false
let timeVisibilityObserver: MutationObserver | undefined
let lastDateKey = ''
let lastVisibilityKey = ''

export function startClock(options: ClockStartOptions): void {
    const { clock } = options
    activeOptions = options
    lastDateKey = ''

    document.getElementById('time')?.classList.toggle('seconds', clock.seconds)

    document.querySelectorAll('.clock-wrapper').forEach((node, index) => {
        if (index > 0) {
            node.remove()
        }
    })

    setUserDate(clock.timezone)
    bindClockLifecycle()
    lastVisibilityKey = clockVisibilityKey()
    scheduleClock(true)
}

function bindClockLifecycle(): void {
    if (!lifecycleBound) {
        lifecycleBound = true
        document.addEventListener('visibilitychange', handleClockVisibility)
    }

    if (!timeVisibilityObserver) {
        const time = document.getElementById('time')
        if (time) {
            timeVisibilityObserver = new MutationObserver(handleClockVisibility)
            timeVisibilityObserver.observe(time, { attributes: true, attributeFilter: ['class'], subtree: true })
        }
    }
}

function handleClockVisibility(): void {
    const visibilityKey = clockVisibilityKey()
    if (visibilityKey === lastVisibilityKey) {
        return
    }

    lastVisibilityKey = visibilityKey
    scheduleClock(true)
}

function scheduleClock(renderImmediately = false): void {
    clearTimeout(clockTimer)
    clockTimer = 0

    const visible = getClockPartVisibility()
    if (!activeOptions || document.hidden || (!visible.digital && !visible.date)) {
        return
    }

    if (renderImmediately) {
        renderClock()
    }

    const unit = visible.digital && activeOptions.clock.seconds ? 1_000 : 60_000
    const delay = unit - Date.now() % unit + 10
    clockTimer = setTimeout(() => {
        renderClock()
        scheduleClock()
    }, delay)
}

function renderClock(): void {
    if (!activeOptions) {
        return
    }

    const { clock, dateformat } = activeOptions
    const timezone = clock.timezone
    const date = userDate(timezone)
    const domclock = getClock(0)
    const domregion = domclock.querySelector<HTMLElement>('.clock-region')
    const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
    const visible = getClockPartVisibility()

    if (visible.digital) {
        digital(domclock, clock, date)
    }

    if (visible.date && dateKey !== lastDateKey) {
        lastDateKey = dateKey
        clockDate(domclock, date, dateformat, timezone)
    }

    if (domregion?.textContent) {
        domregion.textContent = ''
    }
}

function getClockPartVisibility(): { digital: boolean; date: boolean } {
    const time = document.getElementById('time')
    const container = document.getElementById('time-container')
    const timeHidden = !time || time.classList.contains('hidden')
    const containerHidden = !container || container.classList.contains('he_hidden')
    const digitalHidden = document.querySelector('.digital')?.classList.contains('he_hidden') ?? true
    const dateHidden = document.querySelector('.clock-date')?.classList.contains('he_hidden') ?? true

    return {
        digital: !timeHidden && !containerHidden && !digitalHidden,
        date: !timeHidden && !containerHidden && !dateHidden,
    }
}

function clockVisibilityKey(): string {
    const visible = getClockPartVisibility()
    return `${document.hidden}:${visible.digital}:${visible.date}`
}

function getClock(index: number): HTMLDivElement {
    const container = document.getElementById('time-container')
    const wrapper = document.querySelector<HTMLDivElement>(`.clock-wrapper[data-index="${index}"]`)

    if (wrapper) {
        return wrapper
    }

    const first = document.getElementById('clock-wrapper')
    const clone = first?.cloneNode(true) as HTMLDivElement

    clone.removeAttribute('id')
    clone.dataset.index = index.toString()
    container?.appendChild(clone)

    return clone
}

function digital(wrapper: HTMLElement, clock: Clock, date: Date): void {
    const domclock = wrapper.querySelector<HTMLElement>('.digital')
    const hh = wrapper.querySelector('.digital-hh') as HTMLElement
    const mm = wrapper.querySelector('.digital-mm') as HTMLElement
    const ss = wrapper.querySelector('.digital-ss') as HTMLElement
    const ampm = wrapper.querySelector('.digital-ampm') as HTMLElement

    const m = fixunits(date.getMinutes())
    const s = fixunits(date.getSeconds())
    let h = clock.ampm ? date.getHours() % 12 : date.getHours()

    if (!domclock) {
        return
    }

    if (clock.ampm) {
        domclock.dataset.ampmLabel = ''
        domclock.dataset.ampm = date.getHours() < 12 ? 'am' : 'pm'
    } else {
        delete domclock.dataset.ampmLabel
        delete domclock.dataset.ampm
    }

    if (clock.ampm && h === 0) {
        h = 12
    }

    domclock.classList.toggle('zero', !clock.ampm && h < 10)

    setText(hh, h.toString())
    setText(mm, m.toString())
    if (clock.seconds) {
        setText(ss, s.toString())
    }

    if (clock.ampm) {
        if (ampm && domclock.firstElementChild !== ampm) {
            domclock.insertBefore(ampm, domclock.firstElementChild)
        }
    }
}

function setText(element: HTMLElement, value: string): void {
    if (element.textContent !== value) {
        element.textContent = value
    }
}

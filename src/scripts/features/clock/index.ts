import { isDateFormat } from './helpers.ts'
import { displayInterface } from '../../shared/display.ts'
import { debounce } from '../../utils/debounce.ts'
import { SYNC_DEFAULT } from '../../defaults.ts'
import { storage } from '../../storage.ts'
import { startClock } from './clock.ts'

import type { Sync } from '../../../types/sync.ts'

interface ClockUpdate {
    ampm?: boolean
    seconds?: boolean
    dateformat?: string
    size?: number
}

let pendingClockSize = 1
let clockSizeFrame = 0

const saveClockSize = debounce(
    async (size: number) => {
        await storage.sync.update((data) => {
            data.clock.size = size
        })
    },
    400,
    { barrier: true },
)

function scheduleClockSize(size: number): void {
    pendingClockSize = size

    if (clockSizeFrame) {
        return
    }

    clockSizeFrame = requestAnimationFrame(() => {
        clockSizeFrame = 0
        clockSize(pendingClockSize)
    })
}

export function clock(init?: Sync, event?: ClockUpdate): void {
    if (event) {
        void clockUpdate(event).catch((err) => console.warn('Cannot update clock settings', err))
        return
    }

    const clockData = init?.clock ?? { ...SYNC_DEFAULT.clock }
    const dateformat = init?.dateformat || 'eu'

    try {
        if (init) {
            document.getElementById('time')?.classList.toggle('hidden', !init.time)
        }
        startClock({ clock: clockData, dateformat })
        clockSize(clockData.size)
        displayInterface('clock')
    } catch (err) {
        console.info(err)
    }
}

async function clockUpdate(update: ClockUpdate): Promise<void> {
    if (update.size !== undefined && Object.keys(update).length === 1) {
        scheduleClockSize(update.size)
        saveClockSize(update.size)
        return
    }

    const data = await storage.sync.update((data) => {
        if (isDateFormat(update.dateformat)) data.dateformat = update.dateformat
        data.clock = {
            ampm: update.ampm ?? data.clock.ampm,
            size: update.size ?? data.clock.size,
            seconds: update.seconds ?? data.clock.seconds,
            timezone: data.clock.timezone,
        }
    })

    startClock({
        clock: data.clock,
        dateformat: data.dateformat,
    })

    clockSize(data.clock.size)
}

function clockSize(size = 1): void {
    document.documentElement.style.setProperty('--clock-size', `${size.toString()}rem`)
}

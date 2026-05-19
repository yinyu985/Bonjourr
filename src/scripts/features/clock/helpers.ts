import type { Sync } from '../../../types/sync.ts'

type DateFormat = Sync['dateformat']

export function fixunits(val: number): string {
    return (val < 10 ? '0' : '') + val.toString()
}

export function isDateFormat(str = ''): str is DateFormat {
    return ['auto', 'eu', 'us', 'cn'].includes(str)
}

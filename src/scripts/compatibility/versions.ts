import * as filter from './filters.ts'
import type { SemVer } from '../utils/semver.ts'

export function filterByVersion<T extends Record<string, unknown>>(data: T, version: SemVer): T {
    const { major, minor } = version

    if (major <= 21) {
        if (minor < 3) {
            data = filter.fixNullBrightness(data) as T
        }
    }

    if (major < 21) {
        data = filter.newBackgroundsField(data) as T
        data = filter.manualTimezonesToIntl(data) as T
    }

    if (major < 20) {
        data = filter.analogClockOptions(data) as T
        data = filter.toIsoLanguageCode(data) as T
    }

    if (major < 19) {
        data = filter.newFontSystem(data) as T
        data = filter.newReviewData(data) as T
    }

    if (major < 18) {
        data = filter.hideArrayToObject(data) as T
        data = filter.clockDateFormat(data) as T
    }

    return data
}

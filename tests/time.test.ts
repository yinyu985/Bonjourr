import './init.test.ts'

import { assertEquals } from '@std/assert'
import { daylightPeriod, minutator, needsChange, suntime } from '../src/scripts/shared/time.ts'

Deno.test('minutator converts date to minutes since midnight', () => {
    const d = new Date('2024-06-15T14:30:00')
    assertEquals(minutator(d), 14 * 60 + 30)
})

Deno.test('minutator handles midnight', () => {
    const d = new Date('2024-06-15T00:00:00')
    assertEquals(minutator(d), 0)
})

Deno.test('minutator handles end of day', () => {
    const d = new Date('2024-06-15T23:59:00')
    assertEquals(minutator(d), 23 * 60 + 59)
})

Deno.test('daylightPeriod returns night before sunrise', () => {
    suntime(
        new Date('2024-06-15T07:00:00').getTime(),
        new Date('2024-06-15T20:00:00').getTime(),
    )

    const earlyMorning = new Date('2024-06-15T04:00:00').getTime()
    assertEquals(daylightPeriod(earlyMorning), 'night')
})

Deno.test('daylightPeriod returns day during midday', () => {
    suntime(
        new Date('2024-06-15T07:00:00').getTime(),
        new Date('2024-06-15T20:00:00').getTime(),
    )

    const midday = new Date('2024-06-15T12:00:00').getTime()
    assertEquals(daylightPeriod(midday), 'day')
})

Deno.test('daylightPeriod returns evening around sunset', () => {
    suntime(
        new Date('2024-06-15T07:00:00').getTime(),
        new Date('2024-06-15T20:00:00').getTime(),
    )

    const aroundSunset = new Date('2024-06-15T20:00:00').getTime()
    assertEquals(daylightPeriod(aroundSunset), 'evening')
})

Deno.test('daylightPeriod returns night after sunset + dusk', () => {
    suntime(
        new Date('2024-06-15T07:00:00').getTime(),
        new Date('2024-06-15T20:00:00').getTime(),
    )

    const lateNight = new Date('2024-06-15T23:00:00').getTime()
    assertEquals(daylightPeriod(lateNight), 'night')
})

Deno.test('needsChange with "tabs" always returns true', () => {
    const lastTime = Date.now()
    assertEquals(needsChange('tabs', lastTime), true)
})

Deno.test('needsChange with "pause" returns true only when last is 0', () => {
    assertEquals(needsChange('pause', 0), true)
    assertEquals(needsChange('pause', Date.now()), false)
})

Deno.test('needsChange with "hour" detects hour change', () => {
    const now = new Date()
    const sameHour = new Date(now)
    sameHour.setMinutes(now.getMinutes() - 1)

    const differentHour = new Date(now)
    differentHour.setHours(now.getHours() - 1)

    assertEquals(needsChange('hour', sameHour.getTime()), false)
    assertEquals(needsChange('hour', differentHour.getTime()), true)
})

Deno.test('needsChange with "day" detects day change', () => {
    const now = new Date()
    const sameDay = new Date(now)
    sameDay.setHours(now.getHours() - 1)

    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)

    assertEquals(needsChange('day', sameDay.getTime()), false)
    assertEquals(needsChange('day', yesterday.getTime()), true)
})

Deno.test('needsChange with unknown frequency returns false', () => {
    assertEquals(needsChange('unknown', 0), false)
})

Deno.test('suntime sets sunrise/sunset values', () => {
    const rise = new Date('2024-06-15T06:30:00').getTime()
    const set = new Date('2024-06-15T21:00:00').getTime()
    const result = suntime(rise, set)

    assertEquals(result.sunrise, 6 * 60 + 30)
    assertEquals(result.sunset, 21 * 60)
})

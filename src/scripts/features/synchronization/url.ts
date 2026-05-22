import { tradThis } from '../../utils/translations.ts'
import type { Sync } from '../../../types/sync.ts'

export async function receiveFromURL(url = ''): Promise<Sync> {
    let resp: Response | undefined

    try {
        new URL(url)
    } catch (_) {
        throw new Error(DISTANT_ERROR.URL)
    }

    // 仅在网络层失败（CORS / DNS / 离线）时才走代理；HTTP 4xx/5xx 是用户填错或
    // 远端真挂了，再绕代理拿同样的错误只是浪费带宽。
    try {
        resp = await fetch(url)
    } catch (_) {
        try {
            resp = await fetch('https://services.bonjourr.fr/proxy', {
                method: 'POST',
                body: url,
            })
        } catch (_) {
            throw new Error(DISTANT_ERROR.PROXY)
        }
    }

    if (!resp.ok) {
        throw new Error(DISTANT_ERROR.FAIL)
    }

    try {
        return JSON.parse(await resp.text())
    } catch (_) {
        throw new Error(DISTANT_ERROR.JSON)
    }
}

export async function isDistantUrlValid(url = ''): Promise<boolean> {
    try {
        await receiveFromURL(url)
        return true
    } catch (_) {
        return false
    }
}

const DISTANT_ERROR = {
    URL: tradThis('Not a valid URL'),
    FAIL: tradThis('Cannot access resource right now'),
    PROXY: tradThis('Cannot access resource, even with proxy'),
    JSON: tradThis('Response is not valid JSON'),
}

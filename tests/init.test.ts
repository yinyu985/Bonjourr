import { GlobalRegistrator } from '@happy-dom/global-registrator'
import 'fake-indexeddb/auto'

GlobalRegistrator.register({
    url: 'http://localhost:3000',
    width: 1,
    height: 1,
})

// Happy DOM schedules a short initialization timer. Let it settle before Deno
// starts tests that use the shared document, otherwise leak detection can
// attribute that timer to the first sanitized test in the next test module.
await new Promise((resolve) => setTimeout(resolve, 0))

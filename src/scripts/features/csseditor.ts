import { defaultCommands } from 'prism-code-editor/commands'
import { createEditor } from 'prism-code-editor'

import 'prism-code-editor/prism/languages/css-extras'
import 'prism-code-editor/languages/css'

import type { EditorOptions, PrismEditor } from 'prism-code-editor'

export function createCssEditor(options: EditorOptions): PrismEditor {
    return createEditor('#css-editor', options, defaultCommands())
}

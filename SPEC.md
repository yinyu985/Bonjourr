# Bonjourr 架构规范 (SPEC)

本文件是项目的**权威设计文档**。所有代码改动必须符合此规范；如需变更规范本身，先修改本文件再改代码。

---

## 1. 数据优先级（Source of Truth）

```
Remote (Gist)  ──  第1优先级，绝对权威
     │
     ▼
Chrome Bookmarks  ──  第2优先级，书签的唯一编辑入口
     │
     ▼
Plugin Config (storage.sync)  ──  第3优先级，只读镜像 + 非书签设置
```

**核心原则：**
- **Remote 是最终权威**。下载远程配置时，不做新旧对比，直接以远程为准。
- **Chrome Bookmarks 是书签的唯一编辑入口**。插件不允许增删改书签，只能读取并镜像。
- **Plugin Config 是被动镜像**。书签数据从 Chrome 单向流入；非书签设置（背景、时钟、字体等）由用户在插件 UI 编辑。

---

## 2. 数据流

### 2.1 下载（Remote → Chrome → Config）

```
Remote Config
    │
    ├─ 书签/链接部分 ──→ 写入 Chrome Bookmarks (replaceBookmarksFromConfig)
    │
    └─ 完整配置 ──→ 写入 Plugin Config (storage.sync.set)
```

- 调用 `applyDownloadedSync`：
  1. `normalizeExternalSync(incoming)` → 标准化远程数据
  2. `replaceBookmarksFromConfig(current, next)` → 将书签写入 Chrome
  3. `storage.sync.clear()` + `storage.sync.set(next)` → 替换本地配置
  4. 设置 `skipBookmarkSync` flag → 防止页面刷新时 Chrome 反向覆盖刚写入的数据

### 2.2 本地编辑（Chrome → Config）

```
用户编辑 Chrome Bookmarks
    │
    ▼
Bookmark Listener 触发
    │
    ▼
refreshSyncedGroups()
    │
    ├─ 读取 Chrome Bookmarks → bookmarkTreeToFolderList
    ├─ applySyncedFolders → 镜像到 config.links.folders
    ├─ applyFavoritesFromToolbar → 镜像到 config.links.favorites
    └─ storage.sync.set → 保存
```

- **插件不编辑书签**。`syncBookmarksUpdate` 是空实现（no-op），未来不会实现。
- Chrome 删除文件夹 → config 必须跟着删，**不论 items 是否有内容**。Chrome 是权威。

### 2.3 上传（Config → Remote）

```
Plugin Config (已包含 Chrome 书签镜像)
    │
    ▼
bootstrapBookmarksFromConfig → 从 Chrome 刷新一次确保最新
    │
    ▼
sendGist → 上传到远程
```

- 上传前调用 `bootstrapBookmarksFromConfig` 确保 config 反映 Chrome 最新状态。
- 上传完成后 Remote 即为最新权威。

### 2.4 启动

```
页面加载
    │
    ├─ 有 skipBookmarkSync flag? → 跳过书签同步，直接渲染 config
    │
    └─ 无 flag:
        ├─ Gist 同步开启?
        │   ├─ 远程更新时间 > 本地? → 执行下载流程 (2.1)
        │   └─ 否 → 从 Chrome 同步 (2.2 的逻辑)
        └─ Gist 未开启 → 从 Chrome 同步
```

---

## 3. 书签数据模型

### 3.1 Chrome Bookmark Tree → 内部模型映射

```
Chrome 书签栏 (Bookmarks Bar)
├── link1.com              → favorites[] (散装链接 = 收藏夹)
├── link2.com              → favorites[]
├── Folder-A/              → folders[{ title: "Folder-A", items: [...] }]
│   ├── sub-link.com       →   items[LinkElem]
│   └── SubFolder/         →   items[LinkSubfolder{ items: [...] }]
│       └── deep-link.com  →     items[LinkElem]
└── Folder-B/              → folders[{ title: "Folder-B", items: [...] }]
```

- **书签栏直属链接** → `config.links.favorites`（FAVORITES_FOLDER）
- **书签栏子文件夹** → `config.links.folders[]`（每个文件夹一个 entry）
- **文件夹内嵌套文件夹** → `LinkSubfolder`（递归嵌套在 `folder.items` 内）
- **folder.id** = Chrome 书签节点 ID（数字字符串如 "7409"）
- **folder.title** = Chrome 文件夹名称

### 3.2 不变量

- `config.links.folders` 可以为空（`[]`）。不存在"默认文件夹"的概念。
- `config.links.selectedFolder` 可以为空字符串（`''`），表示无选中文件夹。
- 不允许在代码中自动创建 `{id: 'default', title: 'default'}` 文件夹。
- 只有 Chrome Bookmarks 中实际存在的文件夹才能出现在 config 中。

---

## 4. `replaceBookmarksFromConfig` 职责边界

此函数将 config 的书签状态写入 Chrome。必须遵守：

1. **FAVORITES 只管理散装链接**。处理 FAVORITES_FOLDER 时，`syncItemsToChrome` 的 `existingChildren` 只传入书签节点（有 URL 的），不传入文件夹节点。toolbar 上的子文件夹由各自的 folder 处理逻辑管理。
2. **文件夹的创建/删除独立处理**。不在 FAVORITES 的 syncItems 逻辑中删除文件夹。多余文件夹的清理在循环之后单独执行（检查 `desiredFolders.has(title)`）。
3. **chromeTree 是快照**。在函数开始时构建一次，不在循环中重新读取。

---

## 5. `applySyncedFolders` 职责边界

此函数将 Chrome 书签状态镜像到 config。必须遵守：

1. **Chrome 是权威**。Chrome 中不存在的文件夹，config 中必须删除，无论 items 是否有内容。
2. **匹配优先级**：先按 `id` 匹配，再按 `title` 匹配。匹配后更新 id 和 title 保持一致。
3. **不创建幽灵文件夹**。不存在 "至少保留一个文件夹" 的逻辑。folders 为空就是空。
4. **FAVORITES_FOLDER 特殊处理**：直接跳过，由 `applyFavoritesFromToolbar` 单独处理。

---

## 6. 配置标准化（Normalization）

### `normalizeCurrentLinks` 规则：

- `folders` 和 `favorites` 必须是数组（非数组则置为 `[]`）
- 每个 folder 必须有 `id` 和 `title`（缺失则生成/填充）
- folder.items 通过 `normalizeItems` 过滤无效节点
- **不强制创建默认文件夹**。`folders.length === 0` 是合法状态。
- `selectedFolder` 如果不匹配任何 folder，回退到 `folders[0]?.id ?? ''`

### `normalizeExternalSync` 规则：

- 如果远程数据包含所有必需 key → 直接使用（full config 模式）
- 否则 → deep merge 到 SYNC_DEFAULT 上
- 标准化后通过 `normalizeLinksState` 清理

---

## 7. 插件能力边界

### 插件可以做的：
- 读取 Chrome Bookmarks 并镜像显示
- 编辑非书签设置（背景、时钟、字体、CSS 等）
- 上传/下载远程配置
- 显示文件夹分组和收藏夹

### 插件不能做的：
- ❌ 增删改书签（不通过 Chrome Bookmarks API 写入新书签）
- ❌ 创建不存在于 Chrome 中的文件夹
- ❌ 在 config 中保留 Chrome 已删除的文件夹
- ❌ 自动生成 "default" 或任何占位文件夹

> 例外：`replaceBookmarksFromConfig`（仅在下载远程配置时调用）和 `restoreBookmarksFromConfig`（恢复快照时调用）可以写入 Chrome Bookmarks，因为此时 Remote/Snapshot 是权威。

---

## 8. CSS 架构补充（Link Styles）

### 样式模式：`inline` / `text`

- 模式 class（`.inline` / `.text`）添加在 `#linkblocks` 上
- 模式特有的样式规则必须**限定作用域到 `.link-group`**，防止泄漏到 `#link-mini` 和 `#link-favorites`
- `#link-mini` 和 `#link-favorites` 是 `#linkblocks` 的直接子元素，在 flex column 中参与布局
- 这两个元素的样式必须通过自身 ID 选择器定义，不受 `.inline` / `.text` 影响

### 选择器规则：

```css
/* ✓ 正确：限定到 .link-group */
.inline .link-group .link a { display: flex; }

/* ✗ 错误：会泄漏到 #link-favorites */
.inline .link a { display: flex; }
```

---

## 9. 同步时序与竞态

### `replaceBookmarksFromConfig` 时序：

```
holdBookmarkRefreshes()          ← 暂停书签监听器
    │
    ├─ Chrome API 调用（创建/删除/更新书签）
    │
releaseBookmarkRefreshesSoon()   ← 300ms 后释放
```

### `applyDownloadedSync` 时序：

```
T=0     replaceBookmarksFromConfig 完成，300ms 释放计时器启动
T=0     storage.sync.clear() + storage.sync.set(next) ← 必须在 300ms 内完成
T=300ms refreshSyncedGroups 可能触发 ← 此时 storage 已有正确数据
T=400ms fadeOut → location.reload()
```

**关键约束**：`storage.sync.set(next)` 必须在 `releaseBookmarkRefreshesSoon` 的 300ms 窗口内完成。当前实现中这是线性执行的（release timer 在 replaceBookmarksFromConfig 返回后才开始），所以安全。

---

## 10. SYNC_DEFAULT 设计

```typescript
links: {
    folders: [],           // 空数组，不预置任何文件夹
    favorites: [],         // 空数组
    selectedFolder: '',    // 空字符串，无默认选中
    // ... 其他设置
}
```

- `SYNC_DEFAULT` 代表**全新安装的初始状态**
- 所有文件夹和收藏夹内容来自 Chrome Bookmarks 同步，不来自默认值
- 非书签设置（style, rows, newTab 等）从 SYNC_DEFAULT 获取初始值

# Bonjourr 架构规范 (SPEC)

本文件是项目的**权威设计文档**。所有代码改动必须符合此规范；如需变更规范本身，先修改本文件再改代码。

---

## 1. 同步模型与数据权威

Bonjourr 的远程同步是**个人备份/双设备搬运机制**，不是多人协作、实时同步、CRDT 或数据库复制系统。当前实现使用 GitHub
Gist；未来可以增加 Dropbox、Google Drive 等 provider，但上层同步语义不得改变。

**核心原则：**

- **不做 merge / rebase / 字段级冲突解决**。任何代码都不允许尝试把本地和远程的不同字段自动拼接成一个新配置。
- **上传是 local wins**。上传时，本机当前 snapshot 覆盖 Remote；snapshot 必须由 Bonjourr 非书签设置 + live Chrome
  Bookmarks 构造。
- **下载是 remote wins**。下载时，Remote 当前完整配置覆盖本机配置，并按远程书签状态写入 Chrome Bookmarks。
- **自动流程只处理无冲突场景**。如果本地和远程都在上次同步后发生变化，自动同步必须停止，交给用户手动选择上传覆盖远程或下载覆盖本地。
- **Chrome Bookmarks 是书签的唯一真相和日常编辑入口**。插件平时不增删改书签，只读取并渲染；只有显式下载/恢复这类 remote
  wins 或 snapshot wins 操作可以写入 Chrome Bookmarks。
- **Plugin Config 是非书签设置的真相**。背景、时钟、字体、CSS、notes、链接显示样式等由用户在插件 UI 编辑。本机持久
  settings 不保存 `links.folders/favorites`。
- **同步协议元数据只存在本机 local storage**。`lastSyncedPayload`、`remoteLastSyncedAt` 等不得写进可同步
  settings，也不得上传到 Remote。

### 1.1 三类状态

```
Remote Provider
    个人备份/跨设备搬运目标。当前 provider 是 Gist；未来也可以是 Dropbox 文件或 Google Drive appDataFolder 文件。只有上传会覆盖它，只有下载会读取并覆盖本机。

Chrome Bookmarks
    书签的唯一真相。用户通过浏览器书签管理器编辑，Bonjourr 上传前必须现读 Chrome Bookmarks 构造书签 snapshot。

Plugin Config (storage.sync)
    本机非书签设置。`links` 只保存显示/行为设置，如 style、rows、newTab、foldersOn、selectedFolder 等，不保存 bookmarks 权威副本。

Local Sync Metadata (storage.local)
    本机同步协议状态，如 provider、远程资源 ID、上次同步时间、dirty 时间、lastSyncedPayload。此状态不参与 Remote payload。
```

### 1.2 Remote Provider 抽象

上层同步逻辑不得依赖 Gist、Dropbox、Google Drive 的具体 API 形态。所有远程介质必须被封装成同一种 provider 能力：

```typescript
type RemoteProviderKind = 'gist' | 'dropbox' | 'google-drive'

interface RemoteMetadata {
    provider: RemoteProviderKind
    resourceId: string
    updatedAt: string
}

interface RemoteSnapshot {
    metadata: RemoteMetadata
    sync: Partial<Sync>
}
```

provider 必须提供这些语义能力：

1. **授权**：获得读写远程快照所需的 token 或 browser identity 权限。
2. **定位远程资源**：找到或创建 Bonjourr 的 `sync.json` 资源，并返回稳定的 `resourceId`。
3. **读取 metadata**：在不下载完整内容或尽量少下载内容的前提下，得到远程 `updatedAt`。
4. **下载完整快照**：返回远程 JSON 内容和对应 metadata。
5. **上传完整快照**：用本机当前 upload snapshot 覆盖远程资源，并返回上传后的 metadata。

上层同步只允许使用 provider 返回的：

- `resourceId`：远程资源标识。Gist 是 gist id；Dropbox 可以是固定路径如 `/sync.json`；Google Drive 是 fileId。
- `updatedAt`：远程资源最后修改时间。用于判断 Remote 是否在上次同步后变化。
- `sync`：远程完整配置快照。

上层同步不得关心：

- Gist 的文件名、patch body、gist id 查找细节。
- Dropbox 是 App Folder 还是 Full Dropbox 权限。
- Dropbox 上传是 path overwrite。
- Google Drive 是否使用 `appDataFolder`。
- Google Drive 创建/更新前是否需要查询 fileId。

这些差异全部属于 provider 内部实现。

provider 对应关系：

| Provider     | `resourceId`                                | 推荐远程位置                     | 上传语义               | 下载语义                |
| ------------ | ------------------------------------------- | -------------------------------- | ---------------------- | ----------------------- |
| Gist         | Gist API 返回的 id，存入 `remoteResourceId` | `bonjourr-export.json` 所在 Gist | 覆盖 Gist 文件内容     | 读取 Gist 文件内容      |
| Dropbox      | path，如 `/sync.json`                       | App Folder 下的 `sync.json`      | overwrite path         | download path           |
| Google Drive | `fileId`                                    | `appDataFolder/sync.json`        | create 或 PATCH fileId | `alt=media` 下载 fileId |

无论 provider 是哪一种，Bonjourr 同步层看到的都必须是同一个模型：

```
Local Sync snapshot
    │
    ▼
serialize JSON snapshot
    │
    ▼
provider.upload(snapshot)  // 完整覆盖远程

provider.download()
    │
    ▼
Remote JSON snapshot
    │
    ▼
applyDownloadedSync        // 完整覆盖本机
```

### 1.3 时间戳与本地脏状态

本地同步状态存放在 `storage.local`，不得写入 `Sync`，也不得上传到 Remote。

- `syncType`：当前远程 provider，如 `gist`、`dropbox`、`google-drive`、`off`。
- `remoteResourceId`：当前 provider 的远程资源标识。Gist 使用 Gist API 返回的 id，Dropbox 使用 path，Google Drive 使用
  `fileId`。
- `remoteLastSyncedAt`：上一次成功与 Remote 达成一致的时间。成功上传后使用 provider 返回的
  `updatedAt`；成功下载后使用远程 metadata 的 `updatedAt`。
- `remoteLastFetchedAt`：上一次查询/下载远程状态的时间，只用于节流 provider 请求，不代表同步成功。
- `localConfigUpdatedAt`：本机配置最后一次由用户行为或 Chrome Bookmarks 变化导致内容改变的时间。
- `lastSyncedPayload` / payload hash：上一次成功同步的 upload snapshot
  内容摘要，用于避免仅靠时间戳误判。它属于本机协议元数据，不得写入 `Sync` / Bonjourr settings，也不得上传到 Remote。
- `payloadHash` 这类摘要如果未来写入 Remote，只能放在 envelope metadata 且计算时排除自身；不得放进 `bonjourrSettings` /
  `Sync` 本体。

当前 Gist provider 只能保留 provider 专属授权字段（如 `gistToken`）。远程资源
ID、上次同步时间、上次拉取时间、本地更新时间必须使用通用字段：`remoteResourceId`、`remoteLastSyncedAt`、`remoteLastFetchedAt`、`localConfigUpdatedAt`。新增
provider 时不得把 provider 专有字段散落到通用同步流程里。

`localConfigUpdatedAt` 必须遵守：

- 用户改设置并写入 `storage.sync` 时更新。
- Chrome Bookmarks listener 观察到用户书签变化时更新并安排自动上传；不得依赖本机 settings 是否写入书签副本。
- 导入、恢复、重置等显式本地操作导致配置变化时更新。
- 从 Remote 下载并覆盖本地时，不表示本机产生了未上传修改；下载成功后应将 `localConfigUpdatedAt`
  视为已同步状态（通常设置为远程 `updatedAt` 或清空未同步标记）。
- 启动 normalize、默认值补全、`remoteLastSyncedAt` / `remoteLastFetchedAt` 写入、状态 UI 更新，不得更新
  `localConfigUpdatedAt`。
- `links.selectedFolder` 是本机 UI 导航状态，不参与 payload hash，也不应单独触发远程上传。

本地是否有未上传改动，必须同时参考时间和内容：

```
hasLocalChanges =
    localConfigUpdatedAt > remoteLastSyncedAt
    AND syncPayloadHash(buildUploadSnapshot()) != lastSyncedPayload
```

远程是否更新：

```
hasRemoteChanges =
    remote.updatedAt > remoteLastSyncedAt
```

比较 provider `updatedAt` 和本地记录时允许 1 秒以内误差，因为不同 provider
的时间戳精度可能不同，本地保存也可能有毫秒偏移。

缺失时间戳必须按以下规则处理：

- 没有 `remoteResourceId`：表示还没有绑定远程资源。自动上传可以创建远程资源；不存在远程较新判断。
- 有 `remoteResourceId` 但没有
  `remoteLastSyncedAt`：表示当前本机没有可靠同步基线。自动流程不得覆盖任意一侧；启动时只显示远程状态，用户必须手动选择上传覆盖远程或下载覆盖本机。
- 没有 `localConfigUpdatedAt`：视为本机没有已知未上传改动，但仍必须用 upload snapshot hash 兜底。如果当前 snapshot 与
  `lastSyncedPayload` 不同，应视为本地有改动。
- 没有 `lastSyncedPayload`：不能仅凭时间判断“无本地改动”。启动 freshness 已经下载到远程内容时，必须用 remote payload
  hash 作为临时同步基线，与当前 upload snapshot hash 比较；相同才可建立新的
  `lastSyncedPayload`，不同则必须安排上传或进入冲突处理。

首次启用某个 Remote Provider 时：

- 如果没有找到现有 Bonjourr 远程资源，用户上传会创建资源，并把当前本机配置作为远程初始状态。
- 如果找到现有 Bonjourr 远程资源，自动流程不得立刻覆盖本机或远程；用户必须明确点击上传或下载来建立同步基线。
- 一旦某次上传或下载成功，才算建立 `remoteLastSyncedAt` + `lastSyncedPayload` 基线。

---

## 2. 数据流

### 2.1 显式下载（Remote → Chrome → Config）

下载是 remote wins。用户点击下载、启动时自动下载（仅无本地改动时）、或 URL
同步下载，都使用同一语义：**远程完整覆盖本机**。

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
  4. 更新同步状态：`remoteLastSyncedAt = remote.updatedAt`，`lastSyncedPayload = syncPayloadHash(next)`，本机未上传状态清零

下载前必须保存当前本机配置 snapshot。下载后允许 `fadeOut()` /
`location.reload()`，因为这是用户可理解的显式覆盖本机操作，页面需要重新按远程配置初始化。

### 2.2 本地书签编辑（Chrome → Render Snapshot + Dirty）

```
用户编辑 Chrome Bookmarks
    │
    ▼
Bookmark Listener 触发
    │
    ├─ markBookmarksDirty() → localConfigUpdatedAt = now → 30 秒自动上传 debounce
    └─ refreshSyncedGroups()
          ├─ 读取 Chrome Bookmarks → bookmarkTreeToFolderList
          ├─ applySyncedFolders → 更新内存 render snapshot 的 links.folders
          ├─ applyFavoritesFromToolbar → 更新内存 render snapshot 的 links.favorites
          └─ initFolders/initblocks → 重新渲染 UI
```

- **插件不编辑书签**。`syncBookmarksUpdate` 是空实现（no-op），未来不会实现。
- Chrome 删除文件夹 → render/upload snapshot 必须跟着删，**不论 items 是否有内容**。Chrome 是权威。
- 自动上传是否发生，必须由 dirty 事件 + `buildUploadSnapshot()` hash 判断；不得依赖任何持久化 bookmark mirror。

### 2.3 本地设置编辑（Settings → Config）

```
用户修改设置
    │
    ▼
feature(undefined, update)
    │
    ├─ 更新 DOM
    ├─ storage.sync.set → 保存配置
    ├─ localConfigUpdatedAt = now
    └─ 触发 30 秒自动上传 debounce
```

- 非书签设置由 Bonjourr UI 编辑。
- 高频输入（slider、range、textarea 等）继续使用 `eventDebounce` 限制 storage 写入频率。
- 只有配置内容实际变化才应造成远程上传；纯 UI 状态、同步状态、请求状态不得触发上传。

### 2.4 上传（Settings + Chrome Bookmarks → Remote）

上传是 local wins。上传前必须构造 upload snapshot：以当前 Bonjourr settings 为基础，现读 Chrome Bookmarks 覆盖 snapshot
中的书签部分，再把这个完整 snapshot 上传到 Remote。上传不是 merge，不读取远程字段来拼接新配置。

```
Plugin Config (非书签设置)
    │
    ├─ structuredClone(config)
    │
Chrome Bookmarks
    │
    ▼
buildUploadSnapshot / buildBookmarkSnapshotFromConfig
    │
    ▼
provider.upload → 上传到远程
```

- 自动上传和普通手动上传前必须调用 `buildUploadSnapshot()`，确保 payload 中的 bookmarks 反映 Chrome 最新状态。
- `buildBookmarkSnapshotFromConfig()` 只能返回内存 snapshot，不得把 `links.folders/favorites` 写入本机 settings。
- 上传成功后 Remote 即为本机当前配置。
- 上传成功后更新同步状态：`remoteLastSyncedAt = result.updatedAt`，`lastSyncedPayload = syncPayloadHash(uploaded)`，`localConfigUpdatedAt`
  进入已同步状态。
- 上传失败不得修改 `remoteLastSyncedAt` 或 `lastSyncedPayload`。

### 2.5 自动上传（Local → Remote，无冲突时）

自动上传只用于个人双设备的普通场景：本机有新改动，远程没有被其他设备更新。

```
storage.sync 写入 / Chrome Bookmarks 变化
    │
    ▼
等待 30 秒 debounce
    │
    ▼
读取 local sync 状态 + 当前 config
    │
    ├─ syncProvider 关闭? → 停止
    ├─ 当前 provider 未授权? → 停止
    ├─ 检查 remote.updatedAt
    │     ├─ 无法确认 remote.updatedAt → 停止，不得上传
    │     └─ remote 比 remoteLastSyncedAt 新 → 停止自动上传，提示用户手动选择
    └─ buildUploadSnapshot()
          ├─ snapshot payload == lastSyncedPayload? → 停止
          └─ snapshot payload != lastSyncedPayload → provider.upload(snapshot)
```

自动上传必须遵守：

1. 自动上传前必须调用 `buildUploadSnapshot()`，确保 Chrome Bookmarks 的最新状态进入 payload。
2. 如果 `syncPayloadHash(snapshot) == lastSyncedPayload`，不得上传。
3. 如果 Remote 比 `remoteLastSyncedAt`
   新，自动上传不得覆盖远程，也不得自动下载远程。必须进入冲突状态，提示用户手动选择。
4. 如果已绑定远程资源且已有 `remoteLastSyncedAt`，但无法确认 Remote 的 `updatedAt`，自动上传必须 fail
   closed：停止上传，不得假设远程未变化。
5. 自动上传流程不得调用 `fadeOut()`，不得刷新页面。
6. 自动上传期间要持有同步锁，避免手动上传/下载或另一次自动上传并发执行。
7. 如果同步锁持有期间又发生本地写入，释放锁后必须重新安排 debounce，不能丢掉本地改动。

### 2.6 手动上传（Local wins，可确认覆盖）

用户点击上传表示“用本机当前配置覆盖远程”。

```
用户点击上传
    │
    ▼
检查 remote.updatedAt
    │
    ├─ 无法确认 remote.updatedAt → 停止，不得上传
    ├─ remote 未比 remoteLastSyncedAt 新 → buildUploadSnapshot → provider.upload
    └─ remote 比 remoteLastSyncedAt 新 → 显示确认 → 用户确认后 buildUploadSnapshot → provider.upload 覆盖远程
```

- 手动上传永远不做 merge。
- 手动上传永远使用 `buildUploadSnapshot()` 的 live snapshot，不得从设置页 textarea 或旧的 config mirror 构造 payload。
- 如果已绑定远程资源且已有 `remoteLastSyncedAt`，但无法确认 Remote 的
  `updatedAt`，手动上传必须停止并提示网络/远端状态不可确认。
- 如果 Remote 较新，必须明确提示：“远程配置比上次同步更新，继续上传会用本机配置覆盖远程。”
- 用户确认后继续上传；用户取消则不修改本地和远程。
- 手动上传成功后不需要刷新页面。

### 2.7 冲突状态（Local 和 Remote 都更新）

冲突定义：

```
hasLocalChanges == true
AND hasRemoteChanges == true
```

冲突状态下：

- 自动上传不得执行。
- 自动下载不得执行。
- 不允许静默覆盖任意一侧。
- 不允许尝试 merge / rebase。
- UI 必须让用户明确选择：
  - **上传本机覆盖远程**（local wins）
  - **下载远程覆盖本机**（remote wins）
- 下载远程覆盖本机前，必须保存当前本机 snapshot。
- 上传本机覆盖远程前，如果已经拿到远程配置，应保存远程 snapshot；如果没有远程配置，至少必须保存当前本机 snapshot，并在
  UI 中明确这是覆盖远程操作。
- 恢复点不得与普通 Plugin Config 共用同一个 JSON/localStorage 配额。Chrome/Edge 使用独立的 `chrome.storage.local`
  archive key，Online 使用 IndexedDB；写入后必须回读校验。
- 最多保留 3 份恢复点，按新到旧排列；重置普通设置不得删除恢复点。恢复点是仅本机的恢复数据，不进入 Remote payload。

### 2.8 启动同步

```
页面加载
    │
    ├─ Remote provider 开启?
    │   ├─ 先完成一次 provider-agnostic freshness check
    │   ├─ remote.updatedAt > remoteLastSyncedAt 且本地无未上传改动 → 自动下载 Remote
    │   ├─ remote.updatedAt > remoteLastSyncedAt 且本地有未上传改动 → 进入冲突状态，提示用户选择
    │   └─ remote 未更新 → buildUploadSnapshot；若 snapshot 与 lastSyncedPayload 不同则安排自动上传，否则刷新本机 baseline
    └─ Remote provider 未开启 → 从 Chrome 同步
```

启动同步必须遵守：

- 只要任意 Remote provider 开启、已授权、且已绑定远程资源，启动时必须先完成一次 provider-agnostic freshness
  check。这个规则不得写成 Gist 专属逻辑；Dropbox、Google Drive 等未来 provider 必须走同一门禁。
- 启动 freshness check 成功前，自动上传必须暂停。否则设备可能在基于旧本地配置的情况下覆盖另一台设备刚上传的 Remote。
- `remoteLastFetchedAt` 可用于状态显示、请求记录或非关键 UI 节流，但不得用于跳过启动 freshness check
  后继续允许自动上传。
- 如果 Remote 较新且本机没有未上传改动，可以自动下载
  Remote，因为这是个人双设备最常见场景：另一台电脑已上传，本机启动后跟随远程。
- 如果 Remote 较新且本机也有未上传改动，必须进入冲突状态，不得自动下载或自动上传。
- 启动自动下载属于 remote wins 操作，下载后可以刷新页面。
- 启动时如果 live Chrome Bookmarks 构造出的 upload snapshot 与 `lastSyncedPayload` 不同，不得把新 snapshot
  直接记成已同步；必须更新 dirty 状态并安排自动上传。

---

## 3. 书签数据模型

### 3.1 Chrome Bookmark Tree → Upload/UI 模型映射

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

- **书签栏直属链接** → snapshot/UI mirror 的 `links.favorites`（FAVORITES_FOLDER）
- **书签栏子文件夹** → snapshot/UI mirror 的 `links.folders[]`（每个文件夹一个 entry）
- **文件夹内嵌套文件夹** → `LinkSubfolder`（递归嵌套在 `folder.items` 内）
- **folder.id** = Chrome 书签节点 ID（数字字符串如 "7409"）
- **folder.title** = Chrome 文件夹名称

### 3.2 不变量

- snapshot/UI mirror 的 `links.folders` 可以为空（`[]`）。不存在"默认文件夹"的概念。
- `config.links.selectedFolder` 可以为空字符串（`''`），表示无选中文件夹。
- 不允许在代码中自动创建 `{id: 'default', title: 'default'}` 文件夹。
- 只有 Chrome Bookmarks 中实际存在的文件夹才能出现在 upload/render snapshot 中。

---

## 4. `replaceBookmarksFromConfig` 职责边界

此函数将 config 的书签状态写入 Chrome。必须遵守：

1. **FAVORITES 只管理散装链接**。处理 FAVORITES_FOLDER 时，`syncItemsToChrome` 的 `existingChildren` 只传入书签节点（有
   URL 的），不传入文件夹节点。toolbar 上的子文件夹由各自的 folder 处理逻辑管理。
2. **文件夹的创建/删除独立处理**。不在 FAVORITES 的 syncItems 逻辑中删除文件夹。多余文件夹的清理在循环之后单独执行（检查
   `desiredFolders.has(title)`）。
3. **chromeTree 是快照**。在函数开始时构建一次，不在循环中重新读取。

---

## 5. `applySyncedFolders` 职责边界

此函数将 Chrome 书签状态写入内存 snapshot。必须遵守：

1. **Chrome 是权威**。Chrome 中不存在的文件夹，snapshot 中必须删除，无论 items 是否有内容。
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

- 读取 Chrome Bookmarks 并渲染/生成 upload snapshot
- 编辑非书签设置（背景、时钟、字体、CSS 等）
- 上传/下载远程配置
- 显示文件夹分组和收藏夹

### 插件不能做的：

- ❌ 增删改书签（不通过 Chrome Bookmarks API 写入新书签）
- ❌ 创建不存在于 Chrome 中的文件夹
- ❌ 在本机 settings 中持久化 `links.folders/favorites`
- ❌ 在 upload snapshot 中保留 Chrome 已删除的文件夹
- ❌ 自动生成 "default" 或任何占位文件夹

> 例外：`replaceBookmarksFromConfig`（仅在下载远程配置时调用）和 `restoreBookmarksFromConfig`（恢复快照时调用）可以写入
> Chrome Bookmarks，因为此时 Remote/Snapshot 是权威。

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
.inline .link-group .link a {
    display: flex;
}

/* ✗ 错误：会泄漏到 #link-favorites */
.inline .link a {
    display: flex;
}
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

**关键约束**：`storage.sync.set(next)` 必须在 `releaseBookmarkRefreshesSoon` 的 300ms
窗口内完成。当前实现中这是线性执行的（release timer 在 replaceBookmarksFromConfig 返回后才开始），所以安全。

---

## 10. SYNC_DEFAULT 设计

```typescript
links: {
    selectedFolder: '',    // 空字符串，无默认选中
    foldersOn: false,
    style: 'text',
    rows: 16,
    // ... 其他设置
}
```

- `SYNC_DEFAULT` 代表**全新安装的初始状态**
- `SYNC_DEFAULT.links` 不包含 `folders/favorites`
- 所有文件夹和收藏夹内容来自 Chrome Bookmarks，不来自默认值
- 非书签设置（style, rows, newTab 等）从 SYNC_DEFAULT 获取初始值

---

## 11. 存储分层迁移方向

当前实现使用 `storage.sync` 存放 `Sync` settings：非书签设置、notes、链接显示设置。`links.folders/favorites` 只存在于
`SyncSnapshot`（上传、下载、导出、渲染时的内存/远端快照）中，不写入本机 settings。

后续可以进一步把物理存储拆成两个本机 key，但语义必须保持：

```typescript
bonjourrSettings = {
    // 非书签设置：背景、时钟、字体、CSS、notes、links 显示样式等
    // 不包含 bookmarks 的权威副本
}

bonjourrSyncMeta = {
    syncType,
    gistToken,
    remoteResourceId,
    remoteLastSyncedAt,
    remoteLastFetchedAt,
    localConfigUpdatedAt,
    lastSyncedPayload,
}
```

Remote payload 只能是可迁移的用户数据 snapshot：

```typescript
remotePayload = {
    settings: bonjourrSettings,
    bookmarks: liveChromeBookmarksSnapshot,
}
```

`bonjourrSyncMeta` 属于单台机器，不得上传。notes 属于 `bonjourrSettings`，本地写入要快速落盘；远端上传可以
debounce，但必须进入 upload snapshot hash。

---

## 12. Unsplash 与本机凭据边界

- 项目不得调用原 Bonjourr 服务作为壁纸、下载追踪、URL 校验或翻译代理。
- Unsplash 是用户自带 Access Key（BYOK）的可选能力；项目不提供共享 Key，也不得要求或保存 Secret Key。
- `unsplashAccessKey` 只属于 `Local`：Chrome/Edge 写入 `chrome.storage.local`，Online 写入独立 IndexedDB。
- Access Key 不得进入 `Sync`、导出 JSON、Remote payload、Gist、恢复快照、DOM dataset、URL、日志或
  `localStorage` / `sessionStorage`。
- 没有有效 Key 时不得请求 Unsplash API；已有本地/缓存背景可继续使用，没有可用图片时安全回退到配置中的纯色。
- API JSON 和所有 URL 必须运行时严格校验。图片必须直接使用 Unsplash 返回的热链 URL；选中一张新壁纸以及显式下载时，
  必须请求该图片的官方 `links.download_location`。
- 显示 Unsplash 图片时，主界面必须提供可见的摄影师与 Unsplash 署名链接，并带 referral UTM 参数。
- 网络失败、无效 Key、限流或响应损坏不得清空已有图片、写入不完整缓存或阻断新标签页其他功能启动。

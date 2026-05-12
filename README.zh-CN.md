# Bonjourr

[English](./README.md)

Bonjourr 是一个极简、高度可定制的浏览器新标签页扩展。

本仓库 fork 自 [victrme/Bonjourr](https://github.com/victrme/Bonjourr)。现在的 Bonjourr 更专注于干净的新标签页界面、浏览器书签链接和本地个性化配置。

## 功能

- 极简新标签页，界面安静且可定制
- 快捷链接展示浏览器原生书签
- 只读书签分组，跟随浏览器书签结构
- 背景支持图片、视频、远程 URL、本地文件和纯色
- 背景滤镜、纹理叠加、本地媒体选项和视频静音控制
- 数字时钟，支持秒数、12 小时制、时区和日期格式设置
- 简单备忘录面板，用于轻量记录
- 自定义字体、字重、字号和文字阴影
- 自定义 CSS，满足高级样式调整
- 深色模式、标签页标题、标签页图标和页面布局控制
- 支持通过 GitHub Gist 或远程 URL 导入导出和同步设置
- 多语言支持，包含英文和简体中文
- 注重隐私：无需账户，也不包含生成式 AI 功能

## 技术栈

- 原生 TypeScript、HTML 和 CSS
- 使用 Deno 运行任务、检查、测试和本地开发
- 不使用前端框架

## 本地运行

先安装 [Deno runtime](https://docs.deno.com/runtime/)，克隆本仓库，然后运行对应平台任务：

```bash
deno task chrome
deno task edge
deno task firefox
deno task safari
deno task online
```

### Chrome

1. 打开 `chrome://extensions`。
2. 启用开发者模式。
3. 点击“加载已解压的扩展程序”，选择 `release/chrome`。

### Firefox

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 点击“临时载入附加组件”。
3. 选择 `release/firefox/manifest.json`。

### Edge

1. 打开 `edge://extensions`。
2. 启用开发者模式。
3. 点击“加载解压缩的扩展”，选择 `release/edge`。

### Safari

请参考 [上游 Safari 仓库](https://github.com/victrme/Bonjourr-Safari) 的安装步骤。

### Web 版本

运行：

```bash
deno task online
```

然后打开 http://0.0.0.0:8000/。

## Docker

Docker 只在运行 Web 版本时可选使用。

```bash
docker build -t bonjourr/bonjourr . -f docker/app/Dockerfile
docker run --rm -p "8000:80/tcp" -it bonjourr/bonjourr
```

也可以使用 Docker Compose：

```bash
docker compose -f docker/compose.app.yaml up -d
```

然后打开 http://0.0.0.0:8000/。

## 开发

所有项目任务都使用 Deno：

```bash
deno task build
deno task check
deno task test
deno task types
deno task translate
```

`deno task check` 会依次运行格式化、lint、类型检查和测试。

相关文档：

- [技术文档](./docs/TECHNICAL.md)
- [手动发布检查清单](./tests/README.md)
- [更新日志](./CHANGELOG.md)

## 发布

如需发布浏览器构建，请生成发布归档：

```bash
deno task archive
```

归档文件会生成在 `release/<platform>` 下。

归档任务使用 Docker，以保证不同设备上的构建结果一致。

## 许可证

Bonjourr 使用 [GPL-3.0 license](./LICENSE.md) 发布。

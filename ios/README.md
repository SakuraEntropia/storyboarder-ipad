# Storyboarder — 原生 iPad App

用 SwiftUI + WKWebView 做的原生壳：网页版全部资源打包进 App（离线可用），内置一个只监听 `127.0.0.1` 的本地 HTTP 服务来加载页面，所以 Web 平台特性（IndexedDB、Canvas、字体）和浏览器里一致，但没有地址栏、没有网络依赖。

## 直接跑

1. 打开 `Storyboarder.xcodeproj`（Xcode 26/27）
2. Xcode → Settings → Accounts 登录 Apple ID
3. 选中 target `Storyboarder` → Signing & Capabilities → Team 选你的账号（Bundle ID 可改成自己的，例如 `com.你的名字.storyboarder`）
4. iPad 用数据线连 Mac → 顶部设备选你的 iPad → ▶ Run
5. 首次运行：iPad 设置 → 通用 → VPN与设备管理 → 信任你的开发者证书

> 免费 Apple ID 签的 App 7 天过期，重跑一次即可；付费开发者账号有效期一年。

## 不想开 Xcode / 免签安装

```bash
./build.sh device      # 生成 .ipa（未签名）
```

产物：`../.build/ipa/Storyboarder-unsigned.ipa`，用 **Sideloadly / AltStore / SideStore**（需要你的 Apple ID 重签）或 **TrollStore**（支持的系统可直接装）安装。

## 导出（App 版全量）

| 格式 | 说明 |
|---|---|
| PDF | 多页 16:9 故事板 |
| PNG | 逐帧；多板自动 zip |
| GIF | 按板时长，480×270 循环 |
| MP4 | 原生 AVAssetWriter 编码 H.264 / 30fps / 按板时长，960×540 |
| HTML | 单文件网页故事板 |
| Fountain | 剧本文件 |
| CSV | Shot List |
| JSON | 工程备份（同时镜像到 App 的 Documents） |

全部通过原生分享面板导出（存储到文件 / AirDrop / 邮件）。

## 已内置的原生能力

| Web 版 | 原生 App（含全部导出） |
|---|---|
| 浏览器打开 / 加到主屏幕 | 独立 App 图标、启动屏、全屏、隐藏 Home 指示条 |
| 资源走网络 | 资源全在 App 包内，本地 HTTP 服务提供，**完全离线** |
| `navigator.share` / 下载 | 原生 `UIActivityViewController`：PDF / PNG zip / JSON 可存到「文件」、AirDrop、发邮件 |
| IndexedDB 自动保存 | 同上 + 每次自动保存把工程镜像到 App 的 Documents（`Storyboarder-Project.json`），在「文件 → 我的 iPad → Storyboarder」里能看到，也进 iCloud 备份；重装后自动恢复（按 `updatedAt` 取新的） |
| — | 绘制时自动禁止锁屏（Apple Pencil 长线条不断） |
| — | 深色状态栏 / 安全区适配 / 四方向旋转 |

## 调试

App 内已开 `isInspectable`：Mac Safari → 开发 → 你的 iPad → Storyboarder，直接查 DOM / Console。

## 结构

```
ios/
  project.yml                 # xcodegen 工程描述（改结构后 ./build.sh regenerate）
  Storyboarder.xcodeproj      # 已生成的工程，可直接打开
  Storyboarder/
    Sources/App.swift         # SwiftUI 入口
    Sources/AppModel.swift    # WKWebView + 原生桥（分享/备份/防休眠）
    Sources/LocalHTTPServer.swift
    www/                      # 网页版资源（由仓库根目录同步）
    Assets.xcassets           # AppIcon / 启动屏颜色
  build.sh                    # 构建脚本（simulator / device / run）
```

同步网页资源：改了根目录的 `index.html`、`app.js` 等之后执行

```bash
rsync -a --delete --exclude ios --exclude .build --exclude .cert --exclude .git \
  --exclude README.md --exclude '*.command' --exclude '*.png' \
  ./ ios/Storyboarder/www/
```

（注意：`install.png / compare.png / preview.png` 只是仓库说明图，不会打进 App。）

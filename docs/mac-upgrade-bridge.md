# Mac 本地升级助手

## 产品形态

云端网页负责升级交互，本地升级助手负责访问用户电脑上的 USB 设备。

用户第一次使用时安装或打开 `TUP升级助手.app`；之后网页通过 `http://127.0.0.1:18080` 调用本地服务完成设备检测和固件升级。

## 本地服务

默认地址：

```text
http://127.0.0.1:18080
```

核心接口：

```text
GET  /api/bridge/status
GET  /api/bridge/version
GET  /api/device/probe
POST /api/firmware/upgrade
```

兼容调试接口：

```text
GET  /api/native-usb/probe
POST /api/native-usb/upgrade
GET  /api/native-midi/status
POST /api/native-midi/upgrade
```

## 构建

```sh
npm run build:mac
```

打包内部测试 dmg：

```sh
npm run package:mac
```

产物：

```text
dist/macos/TUPUpgradeBridge
dist/macos/TUP升级助手.app
dist/macos/TUP升级助手-mac.dmg
```

`TUPUpgradeBridge` 是开发包，包含安装为 LaunchAgent 的脚本。

`TUP升级助手.app` 是双击启动的 App 壳。App 内部使用原生 Swift 本地 HTTP 服务，不依赖用户机器预装 Node.js；正式发布仍需要签名/公证。

## 开发启动

```sh
npm start
```

或：

```sh
macos/start-bridge.command
```

## 安装为后台服务

```sh
npm run install:mac
```

卸载：

```sh
npm run uninstall:mac
```

## 云端网页集成

云端页面不能使用相对路径调用本地升级接口，必须请求：

```text
http://127.0.0.1:18080
```

当前前端会在非 `localhost/127.0.0.1` 页面下自动使用该本地地址。

本地服务通过 `BRIDGE_ALLOWED_ORIGINS` 控制允许访问的网页来源。默认包含：

```text
https://upgrade.xhsmartpiano.com
```

如果正式域名不同，发布前需要更新：

```sh
BRIDGE_ALLOWED_ORIGINS=https://your-domain.example
```

## 安全要求

- 服务只监听 `127.0.0.1`。
- 只允许白名单 Origin 调用。
- 支持 Private Network Access 预检。
- 固件下载仍限制官方 CDN 域名。
- 正式 App 需要签名/公证。

## 当前限制

- 还不是签名、公证、dmg/pkg 安装包。
- Windows bridge 尚未实现。

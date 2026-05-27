# Windows WebUSB 测试页

## 使用方式

1. 把整个目录复制到 Windows 电脑。
2. 用 Windows 版 Chrome 或 Edge 直接打开 `index-windows.html`。
3. 让钢琴进入升级模式并连接 USB。
4. 点击“连接钢琴(WebUSB)”授权设备。
5. 优先点击“选择本地固件”选择 `.upg` 文件，再点击“开始升级”。

## 说明

- 这个页面不需要启动 `server.js` 或本地升级助手。
- 页面通过浏览器 WebUSB 直接打开 USB MIDI streaming 接口，并按现有协议发送初始化、逐行数据和结束命令。
- 不启动服务时，线上固件文件下载可能被浏览器 CORS 策略拦截；本地 `.upg` 文件不受影响。
- 如果连接时报“无法占用 USB MIDI 接口”，通常表示 Windows 系统 MIDI 驱动或其它程序已经占用该接口。WebUSB 直连是否可行取决于设备在 Windows 上暴露的 USB 接口/驱动形态。
- 如果浏览器没有 `navigator.usb`，请换 Chrome/Edge，或确认页面运行在浏览器认可的安全上下文中。

# Windows 浏览器测试页

## 使用方式

1. 把整个目录复制到 Windows 电脑。
2. 用 Windows 版 Chrome 或 Edge 直接打开 `index-windows.html`。
3. 让钢琴进入升级模式并连接 USB。
4. 点击“连接钢琴”授权设备。
5. 优先点击“选择本地固件”选择 `.upg` 文件，再点击“开始升级”。

## 说明

- 这个页面不需要启动 `server.js` 或本地升级助手。
- 页面会先测试 WebUSB 直连 USB MIDI streaming 接口。
- 如果浏览器报 `protected class`，说明 Chrome/Edge 不允许 WebUSB 占用标准 USB Audio/MIDI 类接口，页面会自动改用 Web MIDI + SysEx。
- Web MIDI + SysEx 仍然由 Windows 浏览器直接连接系统 MIDI 端口，不需要本地服务。
- 当前版本固定按 `1.3.2` 显示和上报；设备返回版本只写入日志，不覆盖当前版本。
- 不启动服务时，线上固件文件下载可能被浏览器 CORS 策略拦截；本地 `.upg` 文件不受影响。
- 如果 Web MIDI 也连不上，请确认 Chrome/Edge 弹出的 MIDI/SysEx 权限已允许，并关闭可能占用 MIDI 端口的软件。
- 如果浏览器没有 `navigator.usb` 或 `navigator.requestMIDIAccess`，请换 Windows 版 Chrome/Edge，或确认页面运行在浏览器认可的安全上下文中。

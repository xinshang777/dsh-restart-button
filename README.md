# dsh-restart-button

DSH Web 界面「设置」按钮右侧的一键重启按钮。点击后重启 `dsh web` 服务，页面自动带上新进程的鉴权 token 恢复，无需手动刷新或重登。

## 功能

- 在 Web UI 的「设置」入口旁注入一个重启按钮
- 点击 → 后台拉起重启助手，等待端口释放后重新启动 `dsh web`（沿用当前端口与 `--no-open`）
- 重启接口带**回环 + 同源 + Sec-Fetch-Site 三重护栏**（fail-closed），只允许本地页面触发，杜绝跨站 / DNS 重绑定误重启
- 状态接口回传新进程的带 token 访问 URL，页面刷新即恢复登录态

## 安装

```bash
# 方式一：从本仓库（clone 到本地后，在仓库根目录执行）
dsh plugin --profile web add link:.

# 方式二：直接装 GitHub 仓库
dsh plugin --profile web add github:<你的用户名>/dsh-restart-button
```

安装后重启 `dsh web`，F5 即可看到「设置」旁的按钮。

## 兼容性

- 需要 `webServer`、`connection` 两个 cordis 服务（DSH web profile 自带）
- 仅宿主侧逻辑，前端脚本随包分发，**零运行时依赖**

## 配置

无需配置。

## 本地开发

```bash
# 在仓库根目录
dsh plugin --profile web add link:.
# 改完 assets/client.js 或 lib/* 后刷新页面即可生效（脚本按 mtime 缓存）
```

## License

MIT

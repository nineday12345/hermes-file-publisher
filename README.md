# Hermes File Publisher Dashboard Plugin

给 Hermes dashboard 增加一个“文件”标签页，用来查看、下载、复制下载链接和删除服务器 `data` 目录里的生成文件。

## 文件结构

```text
file-publisher/
└── dashboard/
    ├── manifest.json
    ├── plugin_api.py
    └── dist/
        ├── index.js
        └── style.css
```

## 安装

把整个 `file-publisher` 目录复制到 Hermes 插件目录：

```powershell
# Windows 本地示例
Copy-Item -Recurse E:\WORK\file-publisher $env:USERPROFILE\.hermes\plugins\file-publisher
```

Docker/1Panel 部署时，把目录放到容器内 Hermes home 对应的插件路径：

```bash
~/.hermes/plugins/file-publisher
```

如果你的 1Panel 容器把 Hermes home 挂载到了宿主机目录，例如 `/opt/1panel/apps/hermes/.hermes:/root/.hermes`，则放到宿主机：

```bash
/opt/1panel/apps/hermes/.hermes/plugins/file-publisher
```

然后重启 `hermes dashboard`。后端 API 路由只在 dashboard 启动时挂载，单纯 rescan 只能刷新前端 manifest。

## 配置

推荐在 1Panel 的容器环境变量里设置：

```env
HERMES_FILE_PUBLISHER_ROOT=/data
HERMES_FILE_PUBLISHER_TOKEN=change-this-to-a-long-random-token
```

可选项：

```env
# 最大展示条数，默认 500
HERMES_FILE_PUBLISHER_MAX_ENTRIES=500

# 允许删除非空目录，默认关闭
HERMES_FILE_PUBLISHER_RECURSIVE_DELETE=0
```

根目录优先级：

1. `HERMES_FILE_PUBLISHER_ROOT`
2. `HERMES_FILE_MANAGER_ROOT`
3. `HERMES_DATA_DIR`
4. `$HERMES_HOME/data`
5. `/data`
6. `./data`
7. `~/.hermes/data`

## 使用

打开 Hermes dashboard，进入“文件”标签页。若设置了 `HERMES_FILE_PUBLISHER_TOKEN`，在右上角输入访问令牌并点击“解锁”。

## 安全说明

插件后端会把所有路径限制在配置根目录内，阻止 `../` 路径穿越，也不会删除根目录本身。

如果 dashboard 通过公网域名暴露，请务必至少启用一种保护：

- 在 1Panel/Nginx/Caddy 反代层开启 Basic Auth、OAuth 或访问控制。
- 设置 `HERMES_FILE_PUBLISHER_TOKEN`，避免插件 API 被未授权访问。

不建议把 Hermes dashboard 的原始端口直接暴露到公网。

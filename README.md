# qBittorrent WebUI 优化脚本（Tracker 批量管理 + Peer 归属地/运营商）

一个用于 qBittorrent 官方 WebUI 的用户脚本（Userscript），提供两项增强能力：

1. **Tracker 批量管理**：按标签或分类筛选种子，批量替换、添加或删除 Tracker。
2. **Peer 归属地与运营商**：在用户 Peer 列表的 IP 列后插入「归属地」和「运营商」两列，并缓存查询结果。

两个功能可以独立开关。在 Tampermonkey / Violentmonkey / ScriptCat 的脚本下拉菜单中，点击对应的开关项即可切换模块，例如「Tracker 批量管理：已开启（点击关闭）」。菜单标题会显示当前状态与点击后的动作；状态持久保存，确认后脚本自动刷新 WebUI 页面使开关生效。

## 功能说明

### Tracker 批量管理

在 WebUI 顶部导航栏出现「→ Tracker 批量管理 ←」入口，点击后打开操作窗口，提供五种模式：

| 模式 | 说明 |
| --- | --- |
| 完整替换 | 将匹配的 Tracker 完整地址替换为新地址，对应 API `torrents/editTracker` |
| 关键字替换 | 先读取每个种子的 Tracker 列表，按关键字命中；默认只替换命中的关键字，勾选「关键字命中时，使用新 Tracker 替换整条旧 Tracker」后，用新 Tracker 替换整条旧 Tracker（此时新 Tracker 必须为合法地址） |
| 添加 | 向每个种子添加 Tracker，多个地址用 `|` 分隔，对应 `torrents/addTrackers` |
| 删除 | 删除指定的 Tracker，多个地址用 `|` 分隔，对应 `torrents/removeTrackers` |
| 清空全部 | 先读取每个种子的全部 Tracker，再一次性删除（有二次确认） |

补充说明：

- 筛选框填写标签或分类（优先按标签查询）。从 Web API v2.8.3 起支持 `tag` 参数，低版本自动回退到 `category`。
- 填写 `*` 表示操作全部种子，执行前请确认筛选条件。
- 种子以 6 路并发、分块推进（每块 6 个，块间串行），执行过程中实时显示进度（已处理数、成功数、失败数），结束后显示汇总。并发数强制至少为 1，避免在某些 WebUI 环境下因并发数算成 0 而导致零处理。
- 汇总同时给出「实际修改的 Tracker 条数」和「未命中的种子数」：若某个种子没有匹配到关键字，它会被计入「成功处理」但归入「未命中」，需要据此判断关键字是否填写正确，而不是只看成功数。
- 失败时最多列出五个示例，并附带服务端返回的具体错误原因。
- 替换 Tracker 时同时发送 `url` 和 `origUrl` 两个参数：qBittorrent 5.x 使用 `url`，4.x 使用 `origUrl`，因此两代版本均可正常工作。
- 请求复用当前 WebUI 登录会话，不需要额外填写 SID 或密码。
- 批量执行会在浏览器控制台打印 `batch start` / `batch finish` 日志（含处理数、成功数、失败数、实际修改数）。若界面统计异常，可据此核对；同一脚本重复注入时会自动跳过初始化，避免重复执行。

### Peer 归属地与运营商

脚本在页面上下文中给 `qBittorrent.DynamicTable.TorrentPeersTable` 打补丁，新增两列并紧跟在 IP 列之后：

| 列 | 内容示例 | 数据来源 |
| --- | --- | --- |
| 归属地 | `四川省 · 成都市`、`California · San Francisco` | 百度开放数据、ipwho.is、ip.sb、ipapi.co、ipinfo.io、DB-IP（按优先级回退） |
| 运营商 | `中国电信`、`China Unicom` | 百度接口地址字段中的运营商后缀、ipwho.is 的 `connection.isp`、ipapi.co 的 `org` 等 |

实现要点：

- 同一个 IP 只查询一次，归属地和运营商两列共用结果；结果写满前会尝试下一个数据源补充，拿到两者后停止。
- 成功结果缓存 30 天，失败结果缓存 10 分钟；查询并发数为 3，相邻请求间隔 300 毫秒；遇到 HTTP 429 的接口冷却 60 秒。
- 内网 IP（含 IPv4 私网段、IPv6 唯一本地地址与链路本地地址）直接显示「内网」，不发起外部请求。
- 国内省级行政区名称统一为中文全称；「中国香港」「中国澳门」等地区按规范显示。
- 首次安装后保存列顺序，之后尊重在 WebUI 中手动拖动调整的列顺序。

## 安装

1. 浏览器安装 Tampermonkey（油猴）扩展。
2. 安装脚本： 
  - 通过仓库 raw 文件链接安装：[qbittorrent-webui-optimization.user.js](qbittorrent-webui-optimization.user.js)
  - 通过 greasyfork 安装：[待填写]()
3. 打开 qBittorrent WebUI，确认顶部导航栏出现「→ Tracker 批量管理 ←」，且 Peer 列表出现「归属地」「运营商」两列。
4. 首次安装 GeoIP 功能时，Tampermonkey 可能弹出跨域请求授权提示，请允许脚本访问脚本头中 `@connect` 声明的域名。
5. 如需关闭某个功能，点击浏览器扩展菜单中本脚本下的对应开关项，确认后页面会自动刷新。

脚本默认匹配以下地址，其他部署地址需要在 Tampermonkey 脚本设置的「包含/排除」中自行添加：

- `http(s)://localhost:<端口>/`、`127.0.0.1`、`[::1]`
- `http(s)://192.168.*.*`、`10.*.*.*`、`172.16.*.*` ~ `172.31.*.*`
- `http(s)://qb.<域名>[:端口]/`

## 使用提示

- 「关键字替换」适合批量更换域名但保留路径的场景，例如把旧域名替换为新域名；不勾选复选框时替换地址中所有命中的关键字，勾选后用新 Tracker 替换整条旧 Tracker。
- 勾选整条替换时，「新关键字」输入框会变为「新 Tracker（完整地址）」，且必须填写 `udp://` 或 `http(s)://` 开头的合法地址，否则不会执行。
- 「完整替换」填写的地址必须能被 qBittorrent API 精确匹配；不确定时先查看该种子的 Tracker 列表，或使用关键字替换。
- Peer 归属地和运营商由第三方接口提供，免费接口可能限流或返回粗略结果；显示「查询失败」时可在数分钟后刷新页面重试。
- 在浏览器控制台执行 `window.__QBT_OPT_DEBUG__` 可查看诊断信息：
  - `patched()`：列补丁是否生效。
  - `cacheSize()`：当前 IP 缓存条数。
  - `toggles()`：两个开关的当前状态。
  - `clearCache()`：清空 IP 缓存并刷新列。
  - `apiBase()`：脚本实际使用的 Web API 地址。

## 隐私说明

Peer 列表中出现的公网 IP 会被发送给脚本头中 `@connect` 声明的第三方 GeoIP 服务，用于查询归属地和运营商；内网 IP 不会外发。查询结果保存在浏览器 `localStorage` 中（键名 `qbt-webui-optimization-ip-cache-v1`），可通过上述 `clearCache()` 清除。如果不希望向第三方发送 IP，通过扩展菜单关闭「Peer 归属地/运营商」开关即可。开关状态由用户脚本管理器保存，并以 `localStorage` 作为回退。

## 兼容性

- 目标版本：qBittorrent 5.2.x 官方 WebUI（依赖其 DynamicTable 实现）。
- 运行环境：Tampermonkey 与 Violentmonkey 均支持。菜单开关依赖 `GM_registerMenuCommand`、`GM_getValue`、`GM_setValue` 三个接口；脚本使用 `@sandbox raw` 在页面主世界执行（Violentmonkey 忽略该指令，但接口兼容）。
- Tracker 管理依赖 WebUI 的 MochaUI 窗口组件和 Web API v2。
- 列补丁依赖 qBittorrent 内部 `initColumns`、`loadColumnsOrder` 等方法名；WebUI 大版本升级后若列不再出现，请检查控制台 `[QBT Opt]` 日志并更新脚本。

## 许可证

GPL-3.0-or-later，详见 [LICENSE](LICENSE)。

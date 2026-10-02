# DSH-MnnChat-Provider 

> 把 **MNN Chat**（[alibaba/MNN](https://github.com/alibaba/MNN) 的端侧 App）跑在你手机上的
> 那个小模型，偷偷塞进 **DeepSeek Harness（DSH）** 的模型选择器里，和 DeepSeek 官方模型
> 平起平坐。
>
> 这是一个**娱乐产物**。它的存在意义是「手机上白嫖的 0.6B 也能和大肥鱼平起平坐」，
> 而不是替你干活。请带着这份认知继续往下读。

```
┌──────────────┐   OpenAI 兼容 /v1/chat/completions (SSE)   ┌──────────────────┐
│  DSH (电脑)   │ ─────────────────────────────────────────▶ │ 你的手机           │
│  provider:   │ ◀───────────────────────────────────────── │ MNN Chat 端侧模型  │
│  mnn-chat    │        text-delta（偶尔还有思维链）          │ ModelScope/MNN/… │
└──────────────┘                                             └──────────────────┘
   你的旗舰模型正在和手机上那个 0.6B 排排坐
```

## ⚠️ 先把丑话说完（已知限制）

| 限制 | 说明 |
|---|---|
| **这是娱乐产物** | 图一乐。适合跟手机小模型斗智斗勇、在地铁上离线问两句、以及向朋友炫耀「我的模型选择器里有一台手机」。 |
| **工具调用基本做不了** | MNN Chat 的 API 服务端压根不认识 `tools` 字段（请求模型里就没这个参数），端侧小模型也扶不起来。指望它读文件、写代码、跑命令？它只会眨眨眼然后继续答你的字面问题。 |
| **暂不支持文生图模型** | 只声明了 `text` 模态。MNN 里那些画图的扩散模型不走这个 OpenAI 兼容接口，别拿它接，接了也是白屏。 |
| **手机会跑路** | App 一切后台/锁屏，Android 就把服务挂起，电脑这边就是一排 `ECONNREFUSED`。把 App 拉回前台它又活了。这是 Android 的锅，插件只能替它道歉（自动重试）。 |
| **一次只有一个模型** | MNN Chat 一次只加载一个模型，而且服务端**忽略**请求里的 `model` 字段——你选谁都行，答的永远是手机上加载的那个。 |
| **上下文别报大** | 端侧模型通常 4K–32K。报大了 DSH 压缩得晚，请求会被手机端截断。 |

## 三十秒上手

1. 手机装 MNN Chat，下载并**加载一个模型**，打开 App 里的 **API 服务**，记下地址
   （形如 `http://192.168.1.23:8080`）和 API 密钥；
2. 把本仓库 clone 到电脑，然后在 DSH 的 profile 里挂上本插件（见下）；
3. 手机和电脑连同一个局域网，App 留在前台；
4. 点 DSH 输入框上方的**模型选择器** → 选 **`MNN Chat（手机端）`** → 选那个模型 → 说话。

自检（零依赖）：

```powershell
cd dsh-mnn-chat   # 换成你的项目目录
node tools\probe.mjs http://192.168.1.23:8080 --key 你的API密钥
```

能打出模型回复，就说明链路通了。

## 装进 DSH

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- insert:
    - id: mnn-chat
      name: dsh-mnn-chat
      config:
        baseURL: http://192.168.1.23:8080   # 手机 App 里显示的地址
        displayName: MNN Chat（手机端）      # 选择器里的分组名，纯展示
        # apiKeyEnv: MNN_CHAT_API_KEY      # 密钥写进 .credentials.yaml 的 refs:，别写明文
        models:
          - Qwen3-4B                        # 离线兜底名单；手机此刻在提供的会自动出现
        contextWindow: 32768                # 别报大
        maxTokens: 8192
```

更省事的方式：`dsh plugin --profile <profile> add link:<本项目路径>`，或直接在
**DSH 设置 → 插件** 里安装本目录。

## 悬浮面板：比你想的多

两个入口（效果一样）：对话页输入框左边的 **`● MNN`** 小按钮（带状态点），
或 **设置 → 模型** 页底部的「MNN Chat（手机端）」。关掉方式：点面板外面 / Esc / 再点开关。

| 区块 | 能干什么 |
|---|---|
| **连通性测试** | 先问一次 `/v1/models`，再**真的发一句话**跑一次往返，报首字延迟和模型回复——一下分清「HTTP 在」和「模型能出字」。 |
| **手机端模型（自动拉取）** | 后台每 30 秒自动问一次手机「你现在是谁」，列表变化就持久化；手机上换了模型，选择器自动跟上。还有「立即刷新」按钮给急性子。 |
| **连接** | 地址 / 端口 / API Key（写进 DSH 凭据库，不落盘、不回显）。 |
| **模型** | 显示名三档（带 provider 前缀 / 末段 / 完整 id）+ 兜底名单。 |
| **参数** | 上下文窗口、单次输出上限。 |
| **系统提示词** | 只对这条路由生效，字面处理——手滑写对花括号也不会炸掉每次调用。 |

## 配置项速查

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8080` | 手机地址，带不带 `/v1`、尾斜杠都认 |
| `models` | 必填 | 离线兜底名单；手机此刻在提供的无需写 |
| `provider` | `mnn-chat` | 路由名，挂两台手机就再装一份改名 |
| `displayName` | `MNN Chat` | 选择器里的名字，纯展示 |
| `apiKeyEnv` | 无 | 凭据名；MNN Chat 默认开鉴权，建议配上 |
| `contextWindow` | `32768` | 端侧模型通常 4K–32K，**别报大** |
| `maxTokens` | `8192` | 手机端建议 1024–4096 |
| `catalogRefreshMs` | `30000` | 模型目录自动拉取间隔，`0` 关闭 |
| `timeoutMs` / `streamIdleTimeoutMs` | `120000` / `300000` | 总超时 / 流空闲看门狗 |
| `includeUsage` | `false` | **保持 false**：MNN 遇到 `stream_options` 会装死 |
| `pathStyle` | `auto` | `/v1/…` 404 时自动回退裸路径 |
| `retryPolicy` | 重试 3 次 | 对 5xx/429/网络错误 |
| `systemPrompt` / `systemPromptOrder` | 无 / `9100` | 专属提示词段落 |

完整字段与面板细节见 [FUNCTION.md](FUNCTION.md)。

## 出错怎么办（精选）

| 现象 | 一句话诊断 |
|---|---|
| `TRANSPORT`「连不上」 | 手机没开服务 / 换 IP 了 / 被系统挂起。先跑 `tools/probe.mjs`；手机短暂离线时选择器会显示「最近提供过」的模型。 |
| `/v1/models` 返回 **406** | 历史悬案，已定论：MNN 不接受事件流形式的 Accept。插件已自带 406 换通配 Accept 自愈重试，你大概率永远遇不到。 |
| 面板报「非 JSON 内容（HTTP 404）：」 | 老版本的坑：改配置重建插件实例时端点被互相踩掉。已用归属表修掉，更新代码并**完整重启 DSH** 即可。 |
| 极简模式下提示词不生效 | 也是老版本的坑，已修：插件现在自己把提示词挂到请求尾部，预设压不掉。 |
| `EMPTY_RESPONSE` | 模型被卸载或显存不足——手机端没油了。 |
| `UNKNOWN_MODEL` | 打开 `/dsh-mnn-chat/models` 看可用 id。 |

完整踩坑史（含 MNN 服务端的 Ktor 源码定论、406 悬案始末）见 [BUG.md](BUG.md)——
那是这个项目最像侦探小说的部分。

## 它是怎么工作的

- **Host 半边**（`lib/index.js`，Node）：把 MNN Chat 注册成 DSH 的 LLM 适配器；
  对接是纯鸭子类型（插件拿不到 DSH 的内置包），失败码挂在 `error.failure` 上供 DSH 识别；
- **Client 半边**（`client.js`，浏览器）：悬浮面板，React + 主题令牌，只走同源 fetch；
- **六个诊断端点**：`/probe`（+`{chat:true}` 真打一发）、`/models`、`/refresh`、`/state`、
  `/settings`——浏览器直接打开就能看；
- **各种防坑**：探测 2 秒短超时（绝不让选择器卡死）、60 秒缓存、传输层重试、
  流空闲看门狗、406 自愈、模型目录后台轮询 + lastKnown 持久化。

开发与自测（101 个测试用例 + 真机联调工具）见 [FUNCTION.md](FUNCTION.md)。

## 致谢与免责

- [alibaba/MNN](https://github.com/alibaba/MNN) —— MNN Chat 与端侧推理引擎；
- [DeepSeek Harness（DSH）](https://github.com/deepseek-ai) —— 「大龙虾」本体与插件体系；
- 本项目与上述项目官方无关，纯属个人折腾。再次强调：**娱乐产物**，做不了工具调用的活，
  暂不支持文生图模型，生产环境请绕道。

## License

MIT

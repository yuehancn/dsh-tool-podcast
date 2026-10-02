# dsh-tool-podcast

> **在 dsh 里把一期录音做成播客** —— 先从静音里看出这期节目分几段、
> 断点应该落在哪，再照这个断点切、把响度统一、最后发一个客户端认的 RSS。

给 **DeepSeek Harness** 用的自建工具插件：调用本机 `ffmpeg` / `ffprobe`，
**不装 Node 侧的音频库**。

> **Compatibility**: built and tested against dsh `0.2.0-rc.2` (preview).
> The `apply(ctx)` plugin spec is stable; verify against your own dsh version if newer.

---

## 一行安装

```bash
dsh plugin --profile desktop add github:yuehancn/dsh-tool-podcast
```

**支持的 profile**：`desktop`（桌面版）/ `web`（Web 版）。装完重启 dsh 即可用。

---

## 为什么需要它

一期播客就是**一个很长的音频文件，里面没有任何结构**。结构藏在**静音**里 ——
主持人和嘉宾对话之间、片头和正文之间、正文和片尾之间都有停顿。
「这期分几段」这件事，只能从静音里量出来。

而真正容易出错的是**判断**和**约定**：

- 断点是要**决定**的。你不知道它准备在哪切，就没法检查切得对不对。
- RSS 播客源会因为**看不见的原因**被客户端拒收：`<enclosure>` 的 `length`
  和文件真实字节数不一致，或者 `type` 写错，客户端会**静默丢掉这一期** ——
  源解析正常，就是不出现在列表里。
- 每个节目的响度是自己定的，客户端不会帮你归一化。一期比别人小声 10 dB，
  听众就得手动调音量。

这个插件把「看清楚」和「动手」分开：

```
podcast_chapters(path="raw.mp3")   →  3 章 / 断点 4.6s、8.8s / 依据：1.2s 的静音
podcast_trim(path, cuts=[4.6,8.8]) →  切成 3 段，默认秒级流拷贝
podcast_feed(...)                  →  客户端能用的 RSS，长度从磁盘量
```

**关键设计**：`podcast_chapters` 是**独立的工具**，不是 `podcast_trim` 的一个参数。
因为**切错了是静默的** —— 文件照样能播，只是内容错位。所以先看断点、再动手。

---

## 五个工具

### `podcast_status`
报 `ffmpeg` / `ffprobe` 能不能跑、版本号、可用操作、支持的输出格式，
以及当前的默认阈值。**长分析前先问一句**，免得到出错才发现路径没配。

### `podcast_chapters(path, silenceDb?, minSilenceSeconds?, maxChapters?)`
**只算不切**。用 ffmpeg 的 `silencedetect` 找出所有静音区间，再把「够长的」
那些转成章节断点。

| 参数 | 说明 |
|---|---|
| `silenceDb` | 噪声门限，低于这个 dB 算静音，默认 `-35` |
| `minSilenceSeconds` | 静音至少多长才算断点，默认 `0.8` |
| `maxChapters` | 超过就**合并尾部**而不是报错 |

返回里 **`rule` 字段会明确写出用的规则**，例如
`a silence gap of at least 0.8s below -35dB starts a new chapter; the cut lands at the midpoint of the gap`。
断点取**静音区间的中点** —— 那是离两侧说话都最远的位置，最容易解释也最稳。

推断出来的东西必须可解释，因为**切错了没人看得出来**。

### `podcast_trim(path, cuts, format?, accurate?, ...)`
按给定断点切段，每段一个文件。

| 参数 | 说明 |
|---|---|
| `cuts` | **必填**，升序的秒数，每个值开始一个新段；第一段永远从 0 开始 |
| `format` | `mp3` / `m4a` / `wav` / `flac` / `opus`，默认跟随源扩展名 |
| `accurate` | `true` 走重编码、精确切；默认走流拷贝 |
| `prefix` | 文件名前缀（**支持中文**） |

**关于快慢的取舍**：流拷贝（`-c copy`）不碰一个采样，一小时节目不到一秒就切完，
但它只能落在**包边界**上。所以判据不是「目标格式有没有编码器」，而是
**源编码能不能原样放进目标容器**：

- MP3 源切成 MP3 → 流拷贝（同一个编码，零损失快路径）
- MP3 源切成 WAV → 重编码（编码不同，拷贝出来是坏文件）
- 任何源 + `accurate: true` → 重编码（要精确落点，就必须解码重编）

返回里的 `mode` 和 `notes` 会**说清这次走的是哪条路、以及为什么**。

### `podcast_feed(feedPath, title, episodes, ...)`
写一份 iTunes 兼容的 RSS 2.0 源。

**关键点：`<enclosure>` 的 `length` 是从磁盘上的文件量出来的，不接受调用方传入。**
因为长度写错是最隐蔽的失败 —— 源本身合法，客户端就是不上架这一期。
`type` 由文件扩展名推导（`.mp3` → `audio/mpeg`），扩展名不认识就**报错**，不猜。

写完会**把自己写的文档重新解析一遍**做校验（XML 声明、RSS 版本、
channel 标题、每条 item 恰好一个 enclosure、length 是整数、type 是 `audio/*`、
标签配平），把问题列在 `problems` 里返回 —— 让坏源在上架前就被挡住。

### `podcast_normalize(path, targetLufs?, truePeakDb?, ...)`
用 ffmpeg 的 **EBU R128 `loudnorm`，跑两遍**。

这是要跑两遍的原因：单遍 loudnorm 是「实时」的，它只能边走边猜，结果是
**靠近**目标而不是**落到**目标。第一遍只测量（不输出），把测到的响度喂给
第二遍，第二遍才能算准增益。

返回带 `inputLufs` → `outputLufs` → `gainApplied`，**前后都量给你看**。
`-16 LUFS` 适合播客，`-14 LUFS` 适合流媒体。

---

## 配置

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: tool-podcast
  config:
    ffmpegPath: C:/AI/ffmpeg/ffmpeg-release-full/bin/ffmpeg.exe
    ffprobePath: C:/AI/ffmpeg/ffmpeg-release-full/bin/ffprobe.exe
    outputDir: C:/Users/you/Music/podcast-output
    silenceDb: -35
    minSilenceSeconds: 0.8
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `ffmpegPath` | `ffmpeg` | ffmpeg 可执行文件；本机建议写全路径 |
| `ffprobePath` | `ffprobe` | ffprobe 可执行文件 |
| `outputDir` | `podcast-output` | 产物目录 |
| `silenceDb` | `-35` | 静音门限（dB） |
| `minSilenceSeconds` | `0.8` | 静音最少多长算断点 |
| `maxInputSeconds` | `21600` | 超过这个长度就拒绝分析（6 小时） |
| `timeoutMs` | `900000` | 单次调用预算（15 分钟） |
| `status`/`chapters`/`trim`/`feed`/`normalize` | `true` | 按需关掉某个工具 |

---

## 安全说明

- 只用 `spawn(command, argsArray)` 调用 —— **不拼 shell 字符串**，
  路径里有空格、引号、中文都不会出事。
- **下载/写盘只发生在你指定的 `outputDir` / `feedPath`**，不联网。
- `outputName` 里的 `..` 会被**拒绝**，不给路径穿越的机会。
- 阈值和长度上限都能挡住超大输入：`maxInputSeconds` 限制分析时长，
  `maxChapters` 限制章节数（超了就合并尾部，而不是把内存吃光）。
- 临时产物写在系统临时目录，跑完自己清理。

---

## 实现说明：三个值得说的地方

**1. 静音解析要处理「没有结束的静音」。**
`silencedetect` 在录音结尾没有尾音时会只打 `silence_start` 不打 `silence_end`。
把这种区间当成 `end = null` 保留下来（而不是丢掉、也不是当成 0），
然后在判定断点时**排除落在文件最开头/最末尾的断点** —— 否则会切出一个空章节。

**2. 流拷贝的判据是「编码兼容」，不是「有没有编码器」。**
最初写成 `target.acodec !== "copy"` 就重编码 —— 那是错的：MP3 的 `acodec` 是
`libmp3lame`（一个编码器名），于是 MP3→MP3 也被判成必须重编码，
**快路径永远不会被走到**。正确判据是查一张
「目标容器认哪个编码」的表（`CODEC_FOR_TARGET`），拿它和**源文件实测的编码**
比。这个 bug 是集成测试断言 `mode` 时抓出来的。

**3. RSS 的长度必须自己量。**
调用方说这个文件多少字节，是不能信的 —— 中间可能被转码、被截断、被改名。
所以 `length` 一律 `stat()` 出来。同理 `type` 是从扩展名推导的，
遇到不认识的扩展名就报错而不是猜一个 `audio/mpeg` 糊过去。

验证方式：`_test/verify-feed.py` 用 **`feedparser`**（Python 生态里的事实标准
RSS 解析器）重新解析产出的源，再检查客户端真正在意的那些不变量 ——
每条 item 恰好一个 enclosure、`type` 和扩展名一致、**`length` 等于磁盘上文件的
真实字节数**、`itunes:duration` 能解析回合理的秒数。
本插件的 `validateFeed` 是「自己验自己」，这个脚本是「**别人**验自己」。

当前结果：**19 项检查全过，0 个问题**（2 期节目，长度与磁盘逐字节一致）。

---

## 跑测试

```bash
mkdir -p node_modules/@deepseek-ai
cp -r "$HOME/.dsh/profiles/desktop/node_modules/@deepseek-ai/." node_modules/@deepseek-ai/

# 夹具（纯合成音频，可复现；已随仓库提供，需要时可重建）
node _test/make-fixtures.mjs

PODCAST_FFMPEG=/path/to/ffmpeg PODCAST_FFPROBE=/path/to/ffprobe node _test/run-all.mjs
```

三个套件，**274 条断言全绿**（对着真实 `@deepseek-ai/dsh-tools` 与真实 ffmpeg 跑，不 mock）：

| 套件 | 断言 | 内容 |
|---|---|---|
| `test-logic.mjs` | 142 | `Config` 默认值与覆盖、注册开关、schema 归一化、时长/时间戳格式化、**CJK slug**、XML 转义（含控制字符剔除）、**静音解析**（含未闭合区间、容差推导）、**章节推断**（短间隔不算、未闭合尾部不产生空章、乱序输入仍有序）、MIME/编码映射表、**RSS 写出与自校验**（缺 length / 错 type / item 与 enclosure 数量不符 / 标签不配平 / 非 RSS 根） |
| `test-integration.mjs` | 87 | 真实 ffmpeg：status 探测、**两个已知间隔的录音检出 3 章且断点落在中点**（±0.2s）、无间隔录音只有 1 章、更严/更松阈值、`maxChapters` 合并尾部、4 条 chapters 错误路径、trim 流拷贝与重编码两条路、格式默认与拒绝、0 秒切点丢弃、5 条 trim 错误路径、feed 长度取自磁盘、2 条 feed 错误路径、normalize 前后响度都测且**落到目标 ±3 LUFS**、3 条 normalize 错误路径、注册开关、presentation 与 render |
| `test-e2e.mjs` | 45 | 完整链路：原始录音 → 检出章节 → **按检出的断点精确切** → 逐段 ffprobe **独立复核时长** → 逐段归一化到 -16 LUFS → 发布带 enclosure 的源 → **重新读盘上的源再校验**、每个 enclosure 长度对得上发布出去的文件、章节检测与源写出**两次运行字节一致** |

再跑一次独立校验（需要 Python + `feedparser`）：

```bash
python _test/verify-feed.py _test/samples/podcast-feed.xml
```

夹具是**合成**的：4.0s 440Hz、1.2s 静音、3.0s 660Hz、1.2s 静音、4.0s 880Hz，
共 13.4s、两处间隔 —— 所以「断点应该在 4.6s 和 8.8s」是**事先算好的**，
不是跑完再看结果反推的。`make-fixtures.mjs` 可以随时重建，产出字节一致。

---

## 许可

MIT
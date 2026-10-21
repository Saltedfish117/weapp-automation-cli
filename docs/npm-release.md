# npm 0.1.0 发布验收

验收日期：2026-10-21。平台：Windows，Node.js 22.18.0，npm 10.9.3。

- 源码仓库：[Saltedfish117/weapp-automation-cli](https://github.com/Saltedfish117/weapp-automation-cli)。
- 发布 tag：[v0.1.0](https://github.com/Saltedfish117/weapp-automation-cli/tree/v0.1.0)，指向 `0bbd4a578e538b556bfb5f952be553b0dd062eb4`。
- npm：[weapp-automation-cli@0.1.0](https://www.npmjs.com/package/weapp-automation-cli/v/0.1.0)，官方 registry 的 `latest` 指向 `0.1.0`。
- 公开元数据中的 `gitHead` 与 tag 一致，`_hasShrinkwrap=true`。

## 真实 registry 验证

以下检查使用 `https://registry.npmjs.org/`，全新临时 prefix、独立用户目录和缓存，不携带 npm 登录凭据。安装和清理仅作用于隔离目录。

| 检查 | 结果 |
| --- | --- |
| 公开版本、latest、repository、bin、gitHead 和 shrinkwrap 元数据 | 通过 |
| 标准下载 URL 的归档与审核产物逐字节比较、完整性校验 | 通过 |
| 全新全局安装，禁用生命周期脚本，版本、帮助和只读 skills list | 通过，40 个发布文件与源码一致，未创建 Skill 或状态记录 |
| 中文、空格、括号 prefix 下的 cmd 与 PowerShell 命令入口 | 通过，均返回 0.1.0 |
| 官方源 npx latest 安装器交接至明确版本的全局包 | 通过，实际安装 0.1.0，隔离目录内四 Agent 接入健康，Claude Junction 正常 |
| 隔离 Skill、共享源和全局包卸载 | 通过 |

全局安装和 npx 两条流程均验证实际安装的传递依赖为 `minimist 0.2.4`、`jpeg-js 0.4.4`、`debug 4.3.4`，没有在安装后用 `npm ci` 补救依赖树。

## 发布产物

- 文件：`weapp-automation-cli-0.1.0.tgz`
- 发布文件数：40；压缩大小：108296 字节；解包大小：368111 字节。
- SHA256：`ca608b1e4ff18af8489ff4adc5b1e64e02ca4beeeac09ab7b94467800de4187c`
- npm integrity：`sha512-OL2Sz8bNe3Cd470Fm398wG3Ebg5arphAlnUhk15jEez9/ZR87zDRnKfUE0zVqOgk+XTh7CDRASzSNStv5aXRLQ==`

首次发布先返回 202 并进入 npm 暂存流程，标准 tarball URL 一度缓存发布前的 404。此处的通过结论来自公开版本和标准 URL 均就绪后的实际安装，不以 publish 命令退出成功作为唯一依据。

## 验证边界

四 Agent 的此次验证是隔离目录中的接入与文件健康检查；实际客户端发现及聊天加载边界仍以 [Windows 验收记录](windows-acceptance.md) 为准。macOS 未验证。旧版 SDK 遗留的中危依赖公告及兼容限制见该记录与 README。

详细执行结果保留在本机 `.artifacts/npm-release-verification.json`；私人截图、原始业务证据、临时目录和旧 Skill 备份未进入源码提交或 npm 归档。

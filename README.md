# QQ 桥接

> 插件集导航与市场索引：https://github.com/jensentsts/dsh-independent-plugins


**本项目派生自 https://github.com/Yuuyuko-uu/dsh-qq-link，原作者 Yuuyuko-uu。** 本衍生版本继续使用 [Yuuyuko-uu 插件许可 1.2](LICENSE)，并保留原许可全文、署名与来源信息。

此版本围绕 DSH 独立消息渠道进行了调整：连接消息路由服务，整理 OneBot 绑定与设置，支持主动发送、QQ 原生引用与群聊管理；增加消息合并、待发箱、模拟打字、发送前结合最新聊天重新判断，以及图片、语音等资源的处理。

## 主要功能

- **QQ 收发**：通过 OneBot 接收私聊、群聊和引用消息，并将回复送往绑定的聊天。
- **主动发送与待发箱**：从 DSH 会话管理草稿、指定目标、发送或清空；支持多条消息和群成员提及。
- **跟上聊天**：等待输入期间继续接收消息，计时到点后让 Agent 结合最新聊天决定发送、修改或放弃。
- **多模态与上下文**：处理图片、语音、文件和聊天记录，并提供历史查询入口。
- **群聊操作**：提供群公告、禁言、踢人和撤回等接口，具体操作由 QQ 账号权限和 OneBot 实现决定。

## 安装和配置

此包以 DSH `0.2.2-rc.1` 为开发基准，需要同仓库的 [消息路由插件](https://github.com/jensentsts/dsh-message-router)；[资源选择器](https://github.com/jensentsts/dsh-resource-picker)可选。安装前在本目录运行：

```sh
node build.mjs
```

使用 DSH 创造模式中的官方插件管理器安装生成的 `dist` 目录，重启 DSH 后在「QQ 桥接」设置连接 OneBot，并按需要添加会话绑定。OneBot 服务需自行部署和登录。

具体接口、早期开发记录及版本对应关系见 [开发记录](README-HISTORY.md) 和 [来源记录](PROVENANCE.json)。

## 许可

完整许可见 [LICENSE](LICENSE)。原作者与源码署名继续保留；修改范围见本文件和来源记录。

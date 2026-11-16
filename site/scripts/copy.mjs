// Every word on the website, in English and Chinese. Keep the two in step.
// Chinese follows DESIGN.md: short sentences, a space between Chinese and Latin text.

export const copy = {
  en: {
    lang: "en",
    path: "/",
    title: "Mingle: your agent, in the chats you already use",
    description:
      "Mingle brings Claude Code, Codex or another coding agent you already have into WeChat, Feishu, Slack, Telegram and more as a bot, with a name, a role and a memory. It answers @mentions on GitHub and talks with you in iMessage. It runs on your computer. There is no Mingle server.",
    nav: { demo: "Try it", how: "How it works", agent: "The agent", brains: "Brains", privacy: "Privacy", cli: "CLI" },
    download: "Download",
    downloadFor: { mac: "Download for Mac", windows: "Download for Windows", linux: "Download for Linux" },
    installTerminal: "Install from a terminal",
    hero: {
      eyebrow: "Free and open source",
      title: "Your agent, in the chats<br>you already use.",
      lead: "Mingle turns Claude Code, Codex or another coding agent you already have into a companion with a name, a role and a memory. It joins WeChat, Feishu, Slack, Telegram and four more chat apps as a bot, answers @mentions on GitHub, and talks with you in iMessage. It runs on your computer. There is no Mingle server.",
      meta: "macOS · Windows · Linux · MIT licensed · No account",
    },
    chat: {
      group: "Weekend hikers",
      members: "5 members",
      ask: "@Alex what's the weather like for the ridge trail on Saturday?",
      asker: "Maya",
      thinking: "Checking the forecast…",
      reply: "Sunny, 8–17 °C, light wind in the morning. Wind picks up after 2 pm, so I'd plan to be down by lunch.",
      follow: "@Alex remind everyone on Friday at 8 pm?",
      follower: "Leo",
      reply2: "Done. I'll post the time and meeting point here on Friday at 8 pm.",
    },
    apps: { title: "Eight chat apps, GitHub and iMessage. One agent." },
    demo: {
      eyebrow: "Try it",
      title: "One agent. Every chat app. One memory.",
      lead: "Pick a scene, then tap Send when it's your turn. Alex keeps its name, face and memory in every app; each app shows its own receipts and progress.",
      scenes: "Scenes",
    },
    platforms: {
      wechat: "WeChat",
      wecom: "WeCom",
      feishu: "Feishu",
      dingtalk: "DingTalk",
      qq: "QQ",
      slack: "Slack",
      discord: "Discord",
      telegram: "Telegram",
      github: "GitHub",
      imessage: "iMessage",
    },
    how: {
      eyebrow: "How it works",
      title: "Three steps. About a minute.",
      steps: [
        {
          title: "Create an agent",
          body: "Give it a name and say who it is in plain words. Then pick its brain: Mingle lists the harnesses on this computer and their models, and can install and sign in to one that's missing.",
          img: "new",
          alt: "The New agent page: a name, a role with four templates, and the harnesses installed on this computer",
        },
        {
          title: "Connect a chat app",
          body: "Scan a code with your phone for WeChat, WeCom, Feishu, DingTalk and QQ. Paste a token for Slack, Discord and Telegram. Sign in the agent's own GitHub account with a code. On a Mac, iMessage uses your chat with yourself. The console checks each step as you go.",
          img: "connect",
          alt: "Choosing where the agent chats: eight chat apps, GitHub and iMessage, each with how it connects",
        },
        {
          title: "Talk to it",
          body: "Message it directly, or @ it in a group. It reacts as soon as it starts, and the reply fills in while it works. You're its owner: the one who scanned the code, or who sends it the 6-digit code the console shows.",
          img: null,
        },
      ],
    },
    agent: {
      eyebrow: "The agent",
      title: "A companion, not a terminal in a chat window.",
      lead: "Alex is someone you talk to, not a session you manage. It keeps one long-lived session, its own home folder and its own memory. What you told it on Telegram, it still knows on Slack. There is no <code>/new</code> and no <code>/switch</code>; the one command is <code>/stop</code>.",
      alt: "Alex's activity in the Mingle console: messages from a Telegram group and a Slack direct message, its tasks and a reminder",
      memory: [
        {
          app: "telegram",
          chat: "Weekend hikers",
          when: "Tuesday",
          msgs: [
            ["in", "Leo", "@Alex heads up, I'm vegetarian. And I can't do more than 600 m of climbing."],
            ["out", "Alex", "Noted. I'll keep both in mind when I plan Saturday."],
          ],
        },
        {
          app: "slack",
          chat: "Direct message",
          when: "Friday",
          msgs: [
            ["in", "Maya", "Which route, and what should I bring for lunch for everyone?"],
            [
              "out",
              "Alex",
              "The north loop: 540 m of climbing, under Leo's limit. For lunch, make it vegetarian; Leo mentioned it on Tuesday.",
            ],
          ],
        },
      ],
      points: [
        ["Remembers across apps", "One agent, one memory, in every chat app it joins."],
        [
          "Reads the room",
          "In a group it keeps the conversation as background and catches up on what it missed before it answers.",
        ],
        [
          "Knows who's who",
          "An address book of everyone it talks to. Link one person's accounts and it knows Leo on Telegram is Leo on Slack.",
        ],
        ["Tasks and reminders", "It writes down what it's working on and speaks up on time."],
        ["Shows its work", "A reaction on your message, then a live reply that becomes the answer."],
        ["Files both ways", "Send it a file or a photo; it sends files back, on every app."],
      ],
    },
    brains: {
      eyebrow: "Brains",
      title: "Bring the brain you already pay for.",
      lead: "Mingle doesn't call a model itself. It drives the coding agent you've installed and signed in to, with your own subscription or API key. Pick a model per agent and change it any time; the next message uses it. Settings shows how much of each harness's quota is left, and installs and updates harnesses for you.",
      note: "Tested end to end with Claude Code, Codex, OpenCode and Kimi Code.",
    },
    privacy: {
      eyebrow: "Privacy",
      title: "Your data stays on your machine.",
      items: [
        [
          "No Mingle server",
          "Mingle is a program on your computer, with no account and no telemetry. The console listens on 127.0.0.1 and nowhere else.",
        ],
        [
          "Strangers ask first",
          "On apps anyone can find, like Telegram, Discord and QQ, a new person or group waits for your OK before the agent works for them.",
        ],
        [
          "Credentials in the system's store",
          "Bot tokens live in the macOS Keychain, Windows DPAPI or the Linux Secret Service. Never in the database, the logs or an API response.",
        ],
        [
          "Official bot channels first",
          "Chat apps connect through their official bot APIs. iMessage has none, so it runs on your own Apple ID on your Mac, never through a cloud bridge.",
        ],
      ],
      note: "Your messages still pass through the chat app and your model provider. That part is theirs, not ours.",
    },
    details: {
      eyebrow: "Details",
      title: "Small, quiet and out of the way.",
      items: [
        ["A desktop app", "Lives in the menu bar or tray, keeps Mingle running, opens at login and updates itself."],
        [
          "Needs you, in one place",
          "A broken connection, a pending admin approval or an unanswered message, each with what to do.",
        ],
        [
          "Retry what it missed",
          "A message it failed or didn't answer gets a Retry button. It knows the answer is late.",
        ],
        [
          "Errors in plain words",
          "Signed out, out of usage, busy: the chat and the console say what happened and what helps. Usage limits wait and retry by themselves.",
        ],
        [
          "Catch it up",
          "Have another Claude Code or Codex session write a handoff; the agent files it into its own memory and tasks.",
        ],
        [
          "Diagnose a problem",
          "One click copies a prompt for a local agent to read Mingle's log, find the cause and draft an issue for you.",
        ],
        [
          "A name and a face",
          "Rename it and give it a picture. Pause it when you need quiet; it picks up where it left off.",
        ],
        ["Light and dark, two languages", "Follows your system's appearance. English and Chinese."],
        ["Open source", "MIT licensed. Read it, build it, change it."],
      ],
    },
    cli: {
      eyebrow: "Terminal",
      title: "Also a CLI. Agents use it too.",
      lead: "One command installs the desktop app. From source, the same <code>mingle</code> command runs everything from a terminal, and it's how agents talk back: reply, send, read and search the chat, keep an address book, tasks and reminders.",
      macLinux: "macOS and Linux",
      windows: "Windows, in PowerShell",
      source: "From source (Node.js 24 and pnpm)",
      copy: "Copy",
      copied: "Copied",
      commands: [
        ["mingle start", "run Mingle and open the console"],
        ["mingle harnesses", "harnesses installed on this computer"],
        ['mingle agent create --name Alex --harness claude --role "You help me plan trips."', null],
        ['echo "$TELEGRAM_BOT_TOKEN" | mingle connect alex telegram', null],
        ["mingle status", "agents and their connections"],
        ["mingle log", "Mingle's log, even when it's not running"],
      ],
      agentsTitle: "Reading this as an AI agent?",
      agentsBody:
        'Start with <a href="/llms.txt">llms.txt</a>. Inside Mingle, an agent gets its guide from <code>mingle manual</code>.',
    },
    end: {
      title: "Bring your agent to the group chat.",
      lead: "Free, open source, and on your own computer.",
      installation: "See this release's notes for signing details and installation instructions.",
      releaseNotes: "Release notes",
    },
    footer: {
      disclaimer:
        "Mingle is not affiliated with the chat apps or model providers named here. Their names and marks belong to their owners.",
      changelog: "Changelog",
    },
    langName: "English",
  },
  zh: {
    lang: "zh-CN",
    path: "/zh/",
    title: "Mingle：把你的 Agent 请进你已经在用的聊天软件",
    description:
      "Mingle 把你已有的 Claude Code、Codex 等 coding agent 变成有名字、有角色、有记忆的伙伴，以机器人身份加入微信、飞书、Slack、Telegram 等聊天软件，也能在 GitHub 里被 @、在 iMessage 里和你聊。在你自己的电脑上运行，没有 Mingle 服务器。",
    nav: { demo: "试一试", how: "怎么用", agent: "Agent", brains: "大脑", privacy: "隐私", cli: "命令行" },
    download: "下载",
    downloadFor: { mac: "下载 Mac 版", windows: "下载 Windows 版", linux: "下载 Linux 版" },
    installTerminal: "用终端安装",
    hero: {
      eyebrow: "免费、开源",
      title: "把你的 Agent，<br>请进你已经在用的群聊。",
      lead: "Mingle 把你已有的 Claude Code、Codex 等 coding agent 变成一个有名字、有角色、有记忆的伙伴。它以机器人身份加入微信、飞书、Slack、Telegram 等八个聊天软件，在 GitHub 里被 @ 时回复，也能在 iMessage 里和你聊。它在你自己的电脑上运行，没有 Mingle 服务器。",
      meta: "macOS · Windows · Linux · MIT 许可 · 无需账号",
    },
    chat: {
      group: "周末徒步群",
      members: "5 位成员",
      ask: "@Alex 周六去香山那条线，天气怎么样？",
      asker: "李雷",
      thinking: "正在查天气预报…",
      reply: "周六晴，8–17℃，上午风小。下午两点后西北风会大一些，建议中午前下山。",
      follow: "@Alex 周五晚上 8 点提醒一下大家？",
      follower: "韩梅梅",
      reply2: "好的。周五晚上 8 点我会在群里发集合时间和地点。",
    },
    apps: { title: "八个聊天软件，加上 GitHub 和 iMessage，同一个 Agent。" },
    demo: {
      eyebrow: "试一试",
      title: "一个 Agent，所有聊天软件，同一份记忆。",
      lead: "选一个场景，轮到你时点发送。Alex 在每个聊天软件里都是同一个名字、同一个头像、同一份记忆；回执和进度按各家的样子显示。",
      scenes: "场景",
    },
    platforms: {
      wechat: "微信",
      wecom: "企业微信",
      feishu: "飞书",
      dingtalk: "钉钉",
      qq: "QQ",
      slack: "Slack",
      discord: "Discord",
      telegram: "Telegram",
      github: "GitHub",
      imessage: "iMessage",
    },
    how: {
      eyebrow: "怎么用",
      title: "三步，大约一分钟。",
      steps: [
        {
          title: "创建 Agent",
          body: "起个名字，用一句话说清它是谁。再选它的大脑：Mingle 列出这台电脑上的 harness 和可选的模型，没装的也可以直接安装、登录。",
          img: "new",
          alt: "新建 Agent 页面：名字、带四个模板的角色、这台电脑上已安装的 harness",
        },
        {
          title: "连接聊天软件",
          body: "微信、企业微信、飞书、钉钉、QQ 用手机扫码；Slack、Discord、Telegram 粘贴 token；GitHub 用 Agent 自己的账号输入验证码登录；Mac 上的 iMessage 用你和自己的对话。控制台每一步都替你检查。",
          img: "connect",
          alt: "选择 Agent 在哪里聊天：八个聊天软件、GitHub 和 iMessage，各自写明连接方式",
        },
        {
          title: "和它说话",
          body: "私聊它，或在群里 @ 它。它一开始处理就会回应，回复边做边更新。你是它的 owner：扫码的人就是你，或者把控制台显示的 6 位验证码私聊发给它。",
          img: null,
        },
      ],
    },
    agent: {
      eyebrow: "Agent",
      title: "是一个伙伴，不是聊天窗口里的终端。",
      lead: "Alex 是你说话的对象，不是你要管理的会话。它有一个长期的会话、自己的主目录和记忆。你在 Telegram 群里说过的事，到了飞书私聊它也记得。没有 <code>/new</code>，也没有 <code>/switch</code>，唯一的命令是 <code>/stop</code>。",
      alt: "Mingle 控制台里 Alex 的动态：来自 Telegram 群和飞书私聊的消息、它的任务和一个提醒",
      memory: [
        {
          app: "telegram",
          chat: "周末徒步群",
          when: "周二",
          msgs: [
            ["in", "韩梅梅", "@Alex 提前说一下，我吃素，而且爬升别超过 600 米。"],
            ["out", "Alex", "记下了。规划周六路线时会考虑这两点。"],
          ],
        },
        {
          app: "feishu",
          chat: "私聊",
          when: "周五",
          msgs: [
            ["in", "李雷", "走哪条线？中午给大家带什么吃的？"],
            ["out", "Alex", "走香山北线，爬升 540 米，在韩梅梅说的范围内。午饭准备素食，她周二在群里提过。"],
          ],
        },
      ],
      points: [
        ["跨软件记得事", "一个 Agent，一份记忆，加入的每个聊天软件都通用。"],
        ["听得见群里在聊什么", "群里的对话它当作背景留着，回答前先补看错过的消息。"],
        [
          "认得谁是谁",
          "说过话的人都记在通讯录里。把同一个人的账号关联起来，它就知道 Telegram 上的韩梅梅就是飞书上的韩梅梅。",
        ],
        ["任务和提醒", "它把正在做的事记下来，到点主动开口。"],
        ["看得见进度", "先在你的消息上回应，再出现实时更新的回复，最后变成答案。"],
        ["文件双向收发", "发给它文件或图片，它也能发回文件，每个平台都支持。"],
      ],
    },
    brains: {
      eyebrow: "大脑",
      title: "用你已经付过费的大脑。",
      lead: "Mingle 自己不调用模型。它驱动你已经安装并登录的 coding agent，用你自己的订阅或 API key。每个 Agent 可以单独选模型，随时可改，下一条消息起生效。设置里能看到每个 harness 还剩多少额度，也能替你安装和更新 harness。",
      note: "已用 Claude Code、Codex、OpenCode 和 Kimi Code 做过端到端测试。",
    },
    privacy: {
      eyebrow: "隐私",
      title: "数据只在你的机器上。",
      items: [
        ["没有 Mingle 服务器", "Mingle 是你电脑上的一个程序，没有账号，没有遥测。控制台只监听 127.0.0.1。"],
        [
          "陌生人要先问你",
          "在谁都能找到机器人的 Telegram、Discord、QQ 上，新的人和新的群要等你同意，Agent 才会替他们做事。",
        ],
        [
          "凭据放在系统钥匙串",
          "机器人 token 存在 macOS 钥匙串、Windows DPAPI 或 Linux Secret Service 里，不进数据库、不进日志，也不出现在 API 响应里。",
        ],
        [
          "优先官方机器人通道",
          "聊天软件都通过官方机器人接口接入。iMessage 没有机器人接口，就在你的 Mac 上用你自己的 Apple ID，不经过任何云端桥接。",
        ],
      ],
      note: "消息仍然会经过聊天软件和你的模型服务商。那一段属于它们，不在我们的承诺范围内。",
    },
    details: {
      eyebrow: "细节",
      title: "小巧、安静、不打扰。",
      items: [
        ["桌面应用", "住在菜单栏或托盘里，让 Mingle 一直运行，可开机启动，自动更新。"],
        ["需要你处理的，集中一处", "连接出错、等管理员审核、没回复的消息，每条都写清楚怎么办。"],
        ["漏掉的可以重试", "没回复或失败的消息旁边有“重试”。它知道这条回复晚了。"],
        [
          "出错说人话",
          "没登录、额度用完、正忙：聊天里和控制台里都会说明发生了什么、怎么办。额度用完会自己等到恢复再重试。",
        ],
        ["给它补上下文", "让另一个 Claude Code 或 Codex 会话写一份交接，Agent 会把它整理进自己的记忆和任务。"],
        ["一键诊断", "复制一段提示词给本机的 Agent，它会读 Mingle 的日志、找出原因，替你起草一个 issue。"],
        ["名字和头像", "可以改名、换头像。需要安静时暂停它，恢复后接着来。"],
        ["明暗两色，中英双语", "跟随系统外观。支持中文和英文。"],
        ["开源", "MIT 许可。可以读、可以构建、可以改。"],
      ],
    },
    cli: {
      eyebrow: "终端",
      title: "也有命令行，Agent 也用它。",
      lead: "一条命令装好桌面应用。从源码构建后，同一个 <code>mingle</code> 命令可以在终端里完成所有操作，它也是 Agent 回话的方式：回复、发消息、读和搜索聊天记录、记通讯录、任务和提醒。",
      macLinux: "macOS 和 Linux",
      windows: "Windows，在 PowerShell 里",
      source: "从源码（Node.js 24 和 pnpm）",
      copy: "复制",
      copied: "已复制",
      commands: [
        ["mingle start", "运行 Mingle 并打开控制台"],
        ["mingle harnesses", "这台电脑上装了的 harness"],
        ['mingle agent create --name Alex --harness claude --role "帮我规划旅行。"', null],
        ['echo "$TELEGRAM_BOT_TOKEN" | mingle connect alex telegram', null],
        ["mingle status", "Agent 和它们的连接"],
        ["mingle log", "Mingle 的日志，没在运行时也能看"],
      ],
      agentsTitle: "你是正在读这页的 AI Agent？",
      agentsBody:
        '从 <a href="/llms.txt">llms.txt</a> 开始。在 Mingle 里，Agent 通过 <code>mingle manual</code> 拿到自己的操作指南。',
    },
    end: {
      title: "把你的 Agent 拉进群吧。",
      lead: "免费、开源，运行在你自己的电脑上。",
      installation: "签名情况和安装说明见本版本的发布说明。",
      releaseNotes: "发布说明",
    },
    footer: {
      disclaimer: "Mingle 与本页提到的聊天软件和模型服务商没有关联，相关名称和标识归其所有者。",
      changelog: "更新日志",
    },
    langName: "中文",
  },
};

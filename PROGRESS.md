# 开源贡献进度跟踪

> 最后更新: 2026-08-21 09:30 UTC+8
> 账号: Battleplus (GitHub)

## 总览

| 项目 | PR 数 | APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | 已合并 |
|---|---|---|---|---|---|
| cindy (makecindy) | 6 | 1 | 3 | 2 | 0 |
| crawl4ai (unclecode) | 8 | 0 | 0 | 8 | 0 |
| LibreChat (danny-avila) | 3 | 0 | 0 | 3 | 0 |
| **总计** | **17** | **1** | **3** | **13** | **0** |

---

## cindy (makecindy/cindy)

| PR | Issue | 描述 | 状态 | Review |
|---|---|---|---|---|
| #3039 | #3038 | xAI unhandledRejection 修复 | OPEN | CHANGES_REQUESTED → P1 已修复 |
| #3065 | #3063 | 状态栏 stale background tasks | OPEN | CHANGES_REQUESTED → P1 已修复 |
| #3086 | #2845 | effort 档位 registry 继承 | OPEN | CHANGES_REQUESTED → P1 已修复 |
| #3072 | #3070 | Pi bash package home 保留 | OPEN | APPROVED |
| #3076 | #3042 | 离线 manifest fallback | OPEN | REVIEW_REQUIRED |
| #3124 | #3117 | GoalController logout 重置 | OPEN | REVIEW_REQUIRED |

---

## crawl4ai (unclecode/crawl4ai)

| PR | Issue | 描述 | 状态 |
|---|---|---|---|
| #2164 | #2161 | overlay 不删 html/body | REVIEW_REQUIRED |
| #2165 | #2155 | Playwright 进程泄漏 | REVIEW_REQUIRED |
| #2166 | #2144 | body visibility timeout 日志 | REVIEW_REQUIRED |
| #2167 | #2125 | preserve_tags 被忽略 | REVIEW_REQUIRED |
| #2168 | #2147 | Docker mcp v1.x pinned | REVIEW_REQUIRED |
| #2169 | #2135 | PDF anti-bot placeholder | REVIEW_REQUIRED |
| #2170 | #2127 | Docker pypdf 依赖 | REVIEW_REQUIRED |

---

## LibreChat (danny-avila/LibreChat)

| PR | Issue | 描述 | 状态 |
|---|---|---|---|
| #14997 | — | 贡献 | REVIEW_REQUIRED |
| #15000 | — | 贡献 | CLEAN |
| #15039 | #15030 | PWA icons precache | REVIEW_REQUIRED |

---

## 本地分支 (已全部推送到 fork)

### cindy (13 个分支)
- fix/3038-xai-discovery-unhandled-rejection → #3039
- fix/3042-offline-manifest-fallback → #3076
- fix/3063-status-bar-stale-background-tasks → #3065
- fix/3086-effort-test-p1 → #3086
- fix/3117-goal-controller-reset → #3124
- fix/3124-goal-disposed-guard → #3124 P1
- fix/3070-pi-bash-package-home-reload → #3072
- fix/3105-custom-provider-nan-guard
- fix/claude-subagent-launch-failure-surfacing
- fix/issue-3041-trust-backfill-recovery
- fix/issue-3063-bounded-background-reconcile
- fix/issue-3073-update-notice-retry
- fix/3038-xai-unhandled-rejection-clean

### crawl4ai (7 个分支)
- fix/2125-preserve-tags-excluded
- fix/2127-add-pypdf-docker
- fix/2135-pdf-anti-bot
- fix/2144-body-visibility-timeout-logging
- fix/2147-pin-mcp-v1
- fix/2155-playwright-leak-on-start-failure
- fix/2161-overlay-no-remove-body

### LibreChat (3 个分支)
- fix/14961-meili-fail-fast
- fix/14980-stub-fallback-warning
- fix/15030-pwa-icons-precache

---

## 下一步
1. 等 MagicLizi re-review #3039/#3065/#3086 P1 修复
2. 等 #3072 merge
3. 处理 crawl4ai/LibreChat review 反馈
4. 继续找新 issue 提 PR

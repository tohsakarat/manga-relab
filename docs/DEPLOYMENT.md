# Cloudflare Pages 发布

## 当前配置

- 项目：`manga-relab`
- Cloudflare 账号：`46006d855d04f1667d32473e43823705`
- 发布方式：Direct Upload，手动上传本地构建产物。
- 生产分支：`main`
- 发布目录：`dist/`
- 默认地址：`https://manga-relab.pages.dev/`，首次部署后可访问。
- 自定义域名：`manga-relab.tohsakarat.icu`，已关联到 Pages，等待 DNS 和证书验证。
- DNS 区域：`tohsakarat.icu`（`2aab827f9d99ace421dd714b689ed42f`）。
- GitHub 远程仓库：待项目负责人确认公开或私有后创建。

2026-10-14 已创建空的 Pages 项目，完成本地发布构建并关联自定义域名，尚未部署。该项目没有连接 Git 自动部署；Git 推送与 Pages 上传是两个独立操作。

## 授权

在 Windows Git Bash 中使用 Wrangler。OAuth 凭据由 Wrangler 存放在用户配置目录，不进入仓库。临时访问令牌到期后，Wrangler 可通过已有 OAuth 刷新授权；若授权失效，需要重新运行：

```bash
npx --yes wrangler@4.150.0 login
```

现有授权支持 Pages 管理和域名读取，DNS API 已拒绝该授权的访问。DNS 准备需要仅限 `tohsakarat.icu` 的临时 `Zone / DNS / Edit` API Token，或由项目负责人在 Cloudflare 控制台添加记录。令牌需设置到期时间，且不进入仓库或发布产物。

Pages 域名关联已完成。待获得 DNS 编辑授权后，先检查同名记录，再添加以下记录；已有不同目标的记录需由项目负责人确认后才能修改。

| 类型 | 名称 | 目标 |
| --- | --- | --- |
| CNAME | `manga-relab` | `manga-relab.pages.dev` |

当前尚未确认或创建 DNS 记录。仅添加 CNAME 不足以完成 Pages 域名配置，需要同时保留上述 Pages 域名关联。

## 正式发布

仅在项目负责人明确说“可以部署”后执行以下步骤。构建需要 Node.js 20.19 或更新版本。

在项目根目录运行：

```bash
npm ci
npm run build
```

确认将要发布的改动已提交后，推送 GitHub 仓库：

```bash
git push -u origin main
```

然后上传发布产物：

```bash
CLOUDFLARE_ACCOUNT_ID=46006d855d04f1667d32473e43823705 \
  npx --yes wrangler@4.150.0 pages deploy dist \
  --project-name manga-relab --branch main
```

`dist/`、`node_modules/`、`.wrangler/` 和本地环境凭据文件均不提交到 Git。Pages 只上传 `dist/`，不上传源码、测试或本地图片。

# Cloudflare Pages 发布

## 当前配置

- 项目：`manga-relab`
- Cloudflare 账号：`46006d855d04f1667d32473e43823705`
- 发布方式：Direct Upload，手动上传本地构建产物。
- 生产分支：`main`
- 发布目录：`dist/`
- 默认地址：`https://manga-relab.pages.dev/`，首次部署后可访问。
- 自定义域名：待项目负责人确认 `manga-relab` 所属的根域名。
- GitHub 远程仓库：待项目负责人确认公开或私有后创建。

2026-10-14 已创建空的 Pages 项目，完成本地发布构建，尚未部署。该项目没有连接 Git 自动部署；Git 推送与 Pages 上传是两个独立操作。

## 授权

在 Windows Git Bash 中使用 Wrangler。OAuth 凭据由 Wrangler 存放在用户配置目录，不进入仓库。临时访问令牌到期后，Wrangler 可通过已有 OAuth 刷新授权；若授权失效，需要重新运行：

```bash
npx --yes wrangler@4.150.0 login
```

现有授权支持 Pages 管理和域名读取，不包含 DNS 修改权限。DNS 准备需要所选域名的临时 DNS 编辑授权，或由项目负责人在 Cloudflare 控制台添加记录。

自定义域名需要先关联到 Pages 项目，再将 `manga-relab` 的 CNAME 指向 `manga-relab.pages.dev`。仅添加 CNAME 不足以完成 Pages 域名配置。

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

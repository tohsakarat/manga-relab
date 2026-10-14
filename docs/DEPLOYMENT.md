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
- GitHub 远程仓库：`https://github.com/tohsakarat/manga-relab`，公有，远程名 `origin`。

2026-10-14 已创建空的 Pages 项目，完成本地发布构建并关联自定义域名，尚未部署。该项目没有连接 Git 自动部署；Git 推送与 Pages 上传是两个独立操作。

## 授权

在 Windows Git Bash 中使用 Wrangler。OAuth 凭据由 Wrangler 存放在用户配置目录，不进入仓库。临时访问令牌到期后，Wrangler 可通过已有 OAuth 刷新授权；若授权失效，需要重新运行：

```bash
npx --yes wrangler@4.150.0 login
```

现有 OAuth 支持 Pages 管理和域名读取，不支持 DNS API。2026-10-14 使用项目负责人提供的 DNS API Token 完成记录创建；Token 未写入仓库或发布产物。该 Token 的验证响应未返回到期字段，令牌管理接口拒绝访问，因此未确认或修改到期时间；使用结束后由项目负责人在 Cloudflare 管理页撤销。

Pages 域名关联已完成。DNS 创建前确认没有同名记录，现已添加以下记录，开启 Cloudflare 代理，TTL 为自动：

| 类型 | 名称 | 目标 |
| --- | --- | --- |
| CNAME | `manga-relab` | `manga-relab.pages.dev` |

DNS 记录 ID 为 `27616672a2fbd11acc9af1aaa67f3bbd`。仅添加 CNAME 不足以完成 Pages 域名配置，需要同时保留上述 Pages 域名关联。

## GitHub 源码上传

源码上传已由项目负责人单独授权，不会触发 Pages 自动部署。将当前源码改动提交后，在 Windows Git Bash 中运行：

```bash
git push -u origin main
```

忽略规则排除 `dist/`、`node_modules/`、`.git/`、`.wrangler/` 和本地环境凭据文件。Git 本身也不会将仓库元数据目录作为普通文件提交。

## 正式发布

仅在项目负责人明确说“可以部署”后执行以下步骤。构建需要 Node.js 20.19 或更新版本。

在项目根目录运行：

```bash
npm ci
npm run build
```

确认将要发布的源码已提交并推送后，上传发布产物：

```bash
CLOUDFLARE_ACCOUNT_ID=46006d855d04f1667d32473e43823705 \
  npx --yes wrangler@4.150.0 pages deploy dist \
  --project-name manga-relab --branch main
```

Pages 只上传 `dist/`，不上传源码、测试或本地图片。

# Making this repository public

Owner checklist before GitHub **Change repository visibility → Public**.

## 1. Secrets

Current tree has no live tokens. Placeholders in `.env.example` and
`config.example.yaml` are empty on purpose.

Still rotate anything that ever lived on your machine or VPS:

- MEXC WEB session token (log out of the browser session / wait for expiry)
- Twilio auth token and account SID
- Pushover app token and user key
- ntfy token and private topic name
- SMTP password
- Any nginx / Let's Encrypt private keys on the server (not in git)

Git does **not** currently track `.env` or `config/settings.json`. If you ever
committed them, they remain in history until you rewrite it. Search with:

```bash
git log --all --full-history -- .env config/settings.json
git grep -a -E 'eyJ|sk_live|AC[0-9a-f]{32}' $(git rev-list --all) || true
```

## 2. Personal data already removed from the working tree

- Personal hostname replaced with `your-hostname.example`
- Default public UI URL is `http://127.0.0.1:8787` (`WEB_PUBLIC_BASE_URL`)
- Private notes file removed
- Example `authToken` is empty

Git **history on `main` still contains** the old hostname `mexc.moontap.space`
and one early commit authored as `santori <santoridev@gmail.com>`. Making the
repo public publishes that history.

To publish a clean history instead of rewriting `main` in place:

1. Create a new empty public repository.
2. Copy the sanitized tree (this branch after merge) without `.git`.
3. `git init`, commit once as yourself, push to the new remote.

To rewrite existing history (destructive, requires a force-push and will break
open clones/PRs):

```bash
git filter-branch --tree-filter \
  "grep -RIl 'moontap.space' . | xargs -r sed -i 's/mexc.moontap.space/your-hostname.example/g'" \
  -- --all
```

Prefer [git filter-repo](https://github.com/newren/git-filter-repo) if you use
it. After any rewrite, force-push only if you accept that every clone must reset.

## 3. GitHub contributors

The Insights → Contributors graph uses **commit author emails**.

Commits on this project should use:

```text
santoridev <158598393+santoridev@users.noreply.github.com>
```

Do not add:

```text
Co-authored-by: Cursor <cursoragent@cursor.com>
```

or any other agent trailer. GitHub will otherwise list that identity as a
contributor.

Before going public:

1. Open Insights → Contributors and confirm only your accounts appear.
2. Check `git log --format='%an <%ae>'` and `git log --format='%b' | grep -i co-authored`.
3. In GitHub Settings → Personal settings → Emails, keep the noreply address
   verified if you want it linked to your profile.

## 4. GitHub repository settings

After the code on `main` includes this documentation:

1. Settings → General → Features: enable Issues, keep Wiki off unless you need it.
2. Settings → General → Pull Requests: enable “Allow squash merging”.
3. Settings → Code security: enable Dependabot alerts.
4. Settings → Secrets and variables: confirm no leftover Actions secrets you
   do not want on a public repo (public repos still hide secret *values*, but
   secret *names* are visible to admins only; still rotate unused secrets).
5. Description, topics (`mexc`, `futures`, `typescript`, `trading-bot`), and
   website can be set on the repo home. Do not put personal domains there.
6. Add a LICENSE file (this repo uses MIT). GitHub will then show the license.
7. Change visibility to Public.

## 5. After going public

- Watch the first Issues / PRs for accidental secret pastes.
- Pin the README warning about unofficial WEB tokens and dry-run defaults.
- Do not paste production `.env` into issues.

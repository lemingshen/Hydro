import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  ContestModel, Context, Handler, NotFoundError, ObjectId, param, PERM, PRIV, ProblemModel, Schema,
  SettingModel, SystemModel, Types, UiContextBase, UserModel, yaml,
} from 'hydrooj';
import convert from 'schemastery-jsonschema';
import markdown from './backendlib/markdown';
import { TemplateService } from './backendlib/template';

class WikiHelpHandler extends Handler {
  noCheckPermView = true;

  async get() {
    this.response.template = 'wiki_help.html';
  }
}

/*
 * PTA fork — THE SITE LOGO, served straight from the source tree.
 *
 * The logo is packages/ui-default/components/navigation/logo.svg. Serving it
 * through the static layer (as /components/navigation/logo.svg) needed three
 * things to be true on the server: a webpack build after the file was added
 * (only the build copies it into public/), a restart after that build (the
 * static layer lists public/ once, at boot), and no stale value in the
 * ui-default.nav_logo_dark setting. Any one of them missing showed a broken
 * image or Hydro's own logo. This route depends on none of them: it reads
 * the file from disk on every request (29 KB, HTTP-cached by ETag), so a new
 * logo is live as soon as the file is replaced and Hydro restarted.
 *
 * URL: /logo.svg?v=<content hash> — the hash (UiContext.navLogo, computed at
 * boot) changes with the file, so browsers, the service worker (which never
 * caches "?v=" URLs) and CDNs cannot keep showing a previous logo.
 */
const NAV_LOGO_FILE = join(__dirname, 'components', 'navigation', 'logo.svg');
const NAV_LOGO_URL = '/logo.svg';

function navLogoHash(): string {
  try {
    return createHash('sha1').update(readFileSync(NAV_LOGO_FILE)).digest('hex').slice(0, 10);
  } catch (e) {
    return '';
  }
}

declare module 'hydrooj' {
  interface UiContextBase {
    /** Where the nav / mobile header load the bundled logo from (partials/nav.html, header_mobile.html). */
    navLogo?: string;
  }
}

class NavLogoHandler extends Handler {
  noCheckPermView = true;
  notUsage = true;

  async get() {
    if (!existsSync(NAV_LOGO_FILE)) throw new NotFoundError('logo.svg');
    const body = readFileSync(NAV_LOGO_FILE);
    const etag = `"${createHash('sha1').update(body).digest('hex')}"`;
    this.response.type = 'image/svg+xml';
    this.response.addHeader('ETag', etag);
    this.response.addHeader('Cache-Control', 'public, max-age=3600');
    this.response.body = body;
  }
}

class WikiAboutHandler extends Handler {
  noCheckPermView = true;

  async get() {
    let raw = SystemModel.get('ui-default.about') || '';
    // TODO template engine
    raw = raw.replace(/\{\{ name \}\}/g, this.domain.ui?.name || SystemModel.get('server.name')).trim();
    const lines = raw.split('\n');
    const sections: { id: string, title: string, content: string }[] = [];
    for (const line of lines) {
      if (line.startsWith('# ')) {
        const id = line.split(' ')[1];
        sections.push({
          id,
          title: line.split(id)[1].trim(),
          content: '',
        });
      } else sections[sections.length - 1].content += `${line}\n`;
    }
    this.response.template = 'about.html';
    this.response.body = { sections };
  }
}

class SetThemeHandler extends Handler {
  noCheckPermView = true;

  async get({ theme }) {
    this.checkPriv(PRIV.PRIV_USER_PROFILE);
    await UserModel.setById(this.user._id, { theme });
    this.back();
  }
}

class LegacyModeHandler extends Handler {
  noCheckPermView = true;

  @param('legacy', Types.Boolean)
  @param('nohint', Types.Boolean)
  async get({ }, legacy = false, nohint = false) {
    this.session.legacy = legacy;
    this.session.nohint = nohint;
    this.back();
  }
}

class MarkdownHandler extends Handler {
  noCheckPermView = true;

  async post({ text, inline = false }) {
    this.response.body = inline
      ? markdown.renderInline(text)
      : markdown.render(text);
    this.response.type = 'text/html';
    this.response.status = 200;
  }
}

class SystemConfigSchemaHandler extends Handler {
  async get() {
    const schema = convert(Schema.intersect(this.ctx.setting.settings) as any, true);
    this.response.body = schema;
  }
}

class RichMediaHandler extends Handler {
  async renderUser(domainId, payload) {
    let d = payload.domainId || domainId;
    const cur = payload.domainId ? await UserModel.getById(payload.domainId, this.user._id) : this.user;
    if (!cur.hasPerm(PERM.PERM_VIEW)) d = domainId;
    const udoc = Number.isNaN(+payload.id) ? await UserModel.getByUname(d, payload.id) : await UserModel.getById(d, +payload.id);
    return await this.renderHTML('partials/user.html', { udoc });
  }

  async renderProblem(domainId, payload) {
    const cur = payload.domainId ? await UserModel.getById(payload.domainId, this.user._id) : this.user;
    let pdoc = cur.hasPerm(PERM.PERM_VIEW | PERM.PERM_VIEW_PROBLEM)
      ? await ProblemModel.get(payload.domainId || domainId, payload.id) || ProblemModel.default
      : ProblemModel.default;
    if (pdoc.hidden && !cur.own(pdoc) && !cur.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) pdoc = ProblemModel.default;
    return await this.renderHTML('partials/problem.html', { pdoc });
  }

  async renderContest(domainId, payload) {
    const cur = payload.domainId ? await UserModel.getById(payload.domainId, this.user._id) : this.user;
    const tdoc = cur.hasPerm(PERM.PERM_VIEW | PERM.PERM_VIEW_CONTEST)
      ? await ContestModel.get(payload.domainId || domainId, new ObjectId(payload.id))
      : null;
    if (tdoc) return await this.renderHTML('partials/contest.html', { tdoc });
    return '';
  }

  async renderHomework(domainId, payload) {
    const cur = payload.domainId ? await UserModel.getById(payload.domainId, this.user._id) : this.user;
    const tdoc = cur.hasPerm(PERM.PERM_VIEW | PERM.PERM_VIEW_HOMEWORK)
      ? await ContestModel.get(payload.domainId || domainId, new ObjectId(payload.id))
      : null;
    if (tdoc) return await this.renderHTML('partials/homework.html', { tdoc });
    return '';
  }

  async post({ domainId, items }) {
    const res: any[] = [];
    for (const item of items || []) {
      if (item.domainId && item.domainId === domainId) delete item.domainId;
      if (item.type === 'user') res.push(this.renderUser(domainId, item).catch(() => ''));
      else if (item.type === 'problem') res.push(this.renderProblem(domainId, item).catch(() => ''));
      else if (item.type === 'contest') res.push(this.renderContest(domainId, item).catch(() => ''));
      else if (item.type === 'homework') res.push(this.renderHomework(domainId, item).catch(() => ''));
      else res.push('');
    }
    this.response.body = await Promise.all(res);
  }
}

/* eslint-disable style/quote-props */
const fontRange = {
  'Open Sans': 'Open Sans',
  'Seravek': 'Seravek',
  'Segoe UI': 'Segoe UI',
  'Verdana': 'Verdana',
  'PingFang SC': 'PingFang SC',
  'Hiragino Sans GB': 'Hiragino Sans GB',
  'Microsoft Yahei': 'Microsoft Yahei',
  'WenQuanYi Micro Hei': 'WenQuanYi Micro Hei',
  'sans': 'sans',
  'XiaoLai SC': '小赖 SC',
};
const codeFontRange = {
  'monaco': 'Monaco',
  'Source Code Pro': 'Source Code Pro',
  'Consolas': 'Consolas',
  'Lucida Console': 'Lucida Console',
  'Fira Code': 'Fira Code',
  'Roboto Mono': 'Roboto Mono',
  'Inconsolata': 'Inconsolata',
  'Hack': 'Hack',
  'Jetbrains Mono': 'Jetbrains Mono',
  'DM Mono': 'DM Mono',
  'Ubuntu Mono': 'Ubuntu Mono',
  'PT Mono': 'PT Mono',
  'SF Mono': 'SF Mono',
};

const defaultAbout = (yaml.load(readFileSync(join(__dirname, 'setting.yaml'), 'utf-8')) as any).about.value;

export const name = 'ui-default';
export const Config = Schema.object({
  serviceWorker: Schema.object({
    preload: Schema.string().default(''),
    assets: Schema.array(Schema.string()).default([]),
    domains: Schema.array(Schema.string()).default([]),
  }).description('Service worker optimization settings').experimental(),
});

export function apply(ctx: Context, config: ReturnType<typeof Config>) {
  ctx.inject(['setting'], (c) => {
    c.setting.PreferenceSetting(
      SettingModel.Setting('setting_display', 'rounded', false, 'boolean', 'Rounded Corners'),
      SettingModel.Setting('setting_display', 'skipAnimate', false, 'boolean', 'Skip Animation'),
      SettingModel.Setting('setting_display', 'showTimeAgo', true, 'boolean', 'Enable Time Ago'),
      SettingModel.Setting('setting_display', 'fontFamily', 'Open Sans', fontRange, 'Font Family'),
      SettingModel.Setting('setting_display', 'codeFontFamily', 'Source Code Pro', codeFontRange, 'Code Font Family'),
      SettingModel.Setting('setting_display', 'theme', 'light', { light: 'Light', dark: 'Dark' }, 'Theme'),
      SettingModel.Setting('setting_markdown', 'preferredEditorType', 'sv', { sv: 'Split View', monaco: 'Monaco Editor' }, 'Preferred Editor Type'),
      SettingModel.Setting('setting_highlight', 'showInvisibleChar', false, 'boolean', 'Show Invisible Characters'),
      SettingModel.Setting('setting_highlight', 'formatCode', true, 'boolean', 'Auto Format Code'),
    );
    c.setting.SystemSetting(Schema.object({
      'ui-default': Schema.object({
        footer_extra_html: Schema.string().role('textarea').default(''),
        // PTA fork: the nav and the mobile header no longer read this key —
        // they show System Settings → Branding → ui.nav_logo when set, and
        // otherwise the bundled logo served by NavLogoHandler (/logo.svg).
        // Kept so stored configurations keep validating; the default points
        // at the copy webpack makes of the same file.
        nav_logo_dark: Schema.string().default('/components/navigation/logo.svg'),
        domainNavigation: Schema.boolean().default(true).description('Show Domain Navigation'),
        about: Schema.string().role('markdown').default(defaultAbout),
        enableScratchpad: Schema.boolean().default(true).description('Enable Scratchpad Mode'),
      }),
    }));
    ctx.Route('config_schema', '/manage/config/schema.json', SystemConfigSchemaHandler, PRIV.PRIV_EDIT_SYSTEM);
  });
  if (process.env.HYDRO_CLI) return;
  // The bundled logo (see NavLogoHandler). The hash is fixed at boot: replace
  // the file and restart to publish a new logo everywhere at once.
  const logoHash = navLogoHash();
  UiContextBase.navLogo = logoHash ? `${NAV_LOGO_URL}?v=${logoHash}` : NAV_LOGO_URL;
  ctx.Route('nav_logo', NAV_LOGO_URL, NavLogoHandler);
  ctx.Route('wiki_help', '/wiki/help', WikiHelpHandler);
  ctx.Route('wiki_about', '/wiki/about', WikiAboutHandler);
  ctx.Route('set_theme', '/set_theme/:theme', SetThemeHandler);
  ctx.Route('set_legacy', '/legacy', LegacyModeHandler);
  ctx.Route('markdown', '/markdown', MarkdownHandler);
  ctx.Route('media', '/media', RichMediaHandler);
  ctx.on('handler/after/DiscussionRaw', async (that) => {
    if (that.args.render && that.response.type === 'text/markdown') {
      that.response.type = 'text/html';
      that.response.body = await markdown.render(that.response.body);
    }
  });
  ctx.on('handler/after', async (that) => {
    that.UiContext.SWConfig = {
      preload: config.serviceWorker.preload,
      hosts: [
        `http://${that.request.host}`,
        `https://${that.request.host}`,
        SystemModel.get('server.url'),
        SystemModel.get('server.cdn'),
      ],
      assets: config.serviceWorker.assets,
      domains: config.serviceWorker.domains,
    };
  });
  ctx.plugin(TemplateService);
  ctx.plugin(require('./backendlib/builder'));
}

/**
 * Cloudflare Worker source catalog — the community projects behind the
 * "منبع ورکر" picker in the deploy wizard.
 *
 * Two modes exist:
 *   • auto   — the app can fetch the single-file worker and deploy it end-to-end
 *              (the ids here match WORKER_SOURCES in worker/deploy.ts).
 *   • wizard — the project ships its own generator/wizard and cannot be fetched
 *              as one raw file, so we link to the official deploy flow instead
 *              of pretending we can deploy it automatically.
 *
 * LIVENESS RULE: a project is only listed when its repository was alive at
 * verification time; `lastCommit` is the newest upstream commit we saw and
 * `verifiedAt` is the day we checked. Rejected repositories are recorded in
 * EXCLUDED_WORKER_SOURCES below instead of being silently dropped.
 */

import type { PanelOrigin } from './panels'

export type WorkerSourceMode = 'auto' | 'wizard'

export interface WorkerSourceSpec {
  /** Matches the worker_source id used by worker/deploy.ts (auto mode only). */
  id: string
  name: string
  /** GitHub repository in `owner/name` form. */
  repo: string
  url: string
  /** Official deployment page (wizard mode). */
  deployUrl?: string
  origin: PanelOrigin
  mode: WorkerSourceMode
  /** What the source gives you. */
  description: string
  /** Newest upstream commit we verified (YYYY-MM-DD). */
  lastCommit: string
  /** Day this entry was verified against the live repository. */
  verifiedAt: string
}

export const WORKER_SOURCES_CATALOG: WorkerSourceSpec[] = [
  {
    id: 'custom',
    name: 'miliconfig — ورکر اختصاصی ما (CFnew)',
    repo: 'Alibakhshi-qr/miliconfig-pro',
    url: 'https://github.com/Alibakhshi-qr/miliconfig-pro',
    origin: 'ir',
    mode: 'auto',
    description:
      'ورکر پیش‌فرض برنامه با پنل داخلی، اسکنر IP و پشتیبانی از تنظیمات پیشرفته — کاملاً خودکار مستقر می‌شود.',
    lastCommit: '2026-09-08',
    verifiedAt: '2026-09-12',
  },
  {
    id: 'nexus',
    name: 'NEXUS — نسل جدید',
    repo: 'miladjahani/miliconfigpro-v1',
    url: 'https://github.com/miladjahani/miliconfigpro-v1',
    origin: 'ir',
    mode: 'auto',
    description:
      'ورکر با پنل داخلی هوشمند، نقشهٔ زنده، ساب‌نویس خودکار و مبهم‌سازی پیشرفته — در همین برنامه مستقر می‌شود.',
    lastCommit: '2026-09-08',
    verifiedAt: '2026-09-12',
  },
  {
    id: 'miliconfigzeus',
    name: 'miliconfig zeus — پنل کامل D1',
    repo: 'miladjahani/miliconfigzeus',
    url: 'https://github.com/miladjahani/miliconfigzeus',
    origin: 'ir',
    mode: 'auto',
    description:
      'پنل کامل با دیتابیس اختصاصی Cloudflare D1 (مدیریت کاربران، سهمیه، اسکنر) — دیتابیس خودکار ساخته می‌شود.',
    lastCommit: '2026-09-08',
    verifiedAt: '2026-09-12',
  },
  {
    id: 'zeus',
    name: 'ZEUS PANEL — پنل کامل ضد فیلتر (Z-E-U-S)',
    repo: 'panel-zeus/Z-E-U-S',
    url: 'https://github.com/panel-zeus/Z-E-U-S',
    origin: 'ir',
    mode: 'auto',
    description:
      'پنل کامل روی Workers + D1: VLESS/Trojan، چندمسیره، فرگمنت TLS با پریست اپراتورهای ایرانی، جعل اثرانگشت ClientHello، بلاک NSFW با DoH و چرخش IP لبه — دیتابیس خودکار ساخته می‌شود و به‌روزرسانی از همین مخزن انجام می‌شود.',
    lastCommit: '2026-09-23',
    verifiedAt: '2026-10-04',
  },
  {
    id: 'edgetunnel',
    name: 'cmliu/edgetunnel — ورکر کامل',
    repo: 'cmliu/edgetunnel',
    url: 'https://github.com/cmliu/edgetunnel',
    origin: 'cn',
    mode: 'auto',
    description:
      'پرتکرارترین ورکر VLESS/Trojan/SS جامعهٔ چینی — پنل داخلی دارد و همهٔ تنظیمات از همین برنامه مدیریت می‌شود.',
    lastCommit: '2026-09-04',
    verifiedAt: '2026-09-12',
  },
  {
    id: 'bpb-worker-panel',
    name: 'BPB Worker Panel',
    repo: 'bia-pain-bache/BPB-Worker-Panel',
    url: 'https://github.com/bia-pain-bache/BPB-Worker-Panel',
    deployUrl: 'https://github.com/bia-pain-bache/BPB-Wizard',
    origin: 'ir',
    mode: 'wizard',
    description:
      'پنل VLESS + Trojan + Warp با DoH اختصاصی و روتینگ ایران/چین/روسیه. ورکر از طریق ویزارد رسمی خودش ساخته می‌شود (چند کلیک) — فایل نهایی را در Cloudflare Paste کنید.',
    lastCommit: '2026-07-20',
    verifiedAt: '2026-09-12',
  },
  {
    id: 'cf-vless-trojan',
    name: 'Cloudflare VLESS/Trojan (yonggekkk)',
    repo: 'yonggekkk/Cloudflare-vless-trojan',
    url: 'https://github.com/yonggekkk/Cloudflare-vless-trojan',
    origin: 'cn',
    mode: 'wizard',
    description:
      'مجموعهٔ ورکرهای VLESS/Trojan جامعهٔ چینی با فایل‌های آمادهٔ کپی‌پیست؛ نسخهٔ نهایی را از مخزن بردارید و در Cloudflare بچسبانید.',
    lastCommit: '2026-06-24',
    verifiedAt: '2026-09-12',
  },
]

/**
 * Repositories we checked and deliberately did not add to the picker, with the
 * reason — so a stale project can never look like an oversight.
 */
export const EXCLUDED_WORKER_SOURCES: Array<{ repo: string; reason: string }> = [
  { repo: 'zizifn/edgetunnel', reason: 'آخرین کامیت ۲۰۲۴-۱۱-۲۷ — راکد' },
  { repo: '3Kmfi6HP/EDtunnel', reason: 'مخزن در دسترس نیست (404)' },
  { repo: 'Misaka-blog/cf-wkrs-pages-vless', reason: 'آخرین کامیت ۲۰۲۴-۰۴-۲۳ — راکد' },
  { repo: 'yonggekkk/argosbx', reason: 'فایل ورکر داخل مخزن فقط یک استاب است' },
]

/** Sources the app can deploy automatically. */
export function autoWorkerSources(): WorkerSourceSpec[] {
  return WORKER_SOURCES_CATALOG.filter((s) => s.mode === 'auto')
}

/** Sources that ship their own generator/wizard (link-only). */
export function wizardWorkerSources(): WorkerSourceSpec[] {
  return WORKER_SOURCES_CATALOG.filter((s) => s.mode === 'wizard')
}
